var fs = require('fs'),
	xml2js = require('xml2js');
var EventEmitter = require('events').EventEmitter;
var parser = new xml2js.Parser();

var DEBUG = 0;

//Container for message information
var mavlinkMessage = function(buffer) {
	//Reported length
	this.length = buffer[1];
	
	//Sequence number
	this.sequence = buffer[2];
	
	//System ID
	this.system = buffer[3];
	
	//Component ID
	this.component = buffer[4];
	
	//Message ID
	this.id = buffer[5];
	
	//Message payload buffer
	this.payload = new Buffer(this.length);
	buffer.copy(this.payload,0,6,6+this.length);
	
	//Checksum
	this.checksum = buffer.readUInt16LE(this.length+6);
	
	//Whole message as a buffer
	this.buffer = new Buffer(this.length + 8);
	buffer.copy(this.buffer,0,0,8+this.length);
}


var mavlink = function(sysid, compid, version, definitions) {
	EventEmitter.call(this);

	//MAVLink Version, default to v1.0
	this.version = version || "v1.0";
	
	//Definitions to load, default to common and APM
	var defs = definitions || ["common", "ardupilotmega"];
	
	//ID's, default to zeros which mean return all messages (but cannot transmit)
	this.sysid = sysid || 0;
	this.compid = compid || 0;
	
	//Create receive message buffer
	this.buffer = new Buffer(512);
	this.bufferIndex = 0;
	this.messageLength = 0;
	
	//Send message sequence
	this.sequence = 0;
	
	//Message definitions
	this.definitions = new Array();
	this.messagesByID = new Array(255);
	this.messagesByName = new Object();
	this.enums = new Array();
	
	//Add definitions to be loaded
	for (var i = 0; i<defs.length; i++) {
		this.addDefinition(defs[i]);
	}
	
	//Initialise message checksums
	this.messageChecksums = new Array();
	
	if (DEBUG) {
		console.log("MAVLink: Loading definitions");
	}
	
	//Load definitions
	this.loadDefinitions();
	
	//Initialise counter for outgoing messages
	this.lastCounter = 0;
};

mavlink.super_ = EventEmitter;
mavlink.prototype = Object.create(EventEmitter.prototype, {
    constructor: {
        value: mavlink,
        enumerable: false
    }
});

//Add new definitions to the array
mavlink.prototype.addDefinition = function(definition) {
	this.definitions[this.definitions.length] = definition;
	if (DEBUG) {
		console.log("MAVLink: Added " + definition + " definition");
	}
}

//Add new message to messages array, create duplicate arrays to allow lookup by ID or name
mavlink.prototype.addMessage = function(message) {
	this.messagesByID[message.$.id] = message;
	this.messagesByName[message.$.name] = message;
	if (DEBUG) {
		console.log("MAVLink: Added " + message.$.name + " message");
	}
}

//Add new enum to enums array
mavlink.prototype.addEnum = function(en) {
	this.enums[this.enums.length] = en;
	if (DEBUG) {
		console.log("MAVLink: Added " + en.$.name + " enum");
	}
}

//Add all messages and calculate checksums for v1.0
mavlink.prototype.addMessages = function(messages) {
	for (var j = 0; j < messages.length; j++) {
		//If we're v1.0 then calculate message checksums
		if (this.version == "v1.0") {
			this.messageChecksums[messages[j].$.id] = this.calculateMessageChecksum(messages[j]);
		}
		this.addMessage(messages[j]);
	}
}

//Add all enums
mavlink.prototype.addEnums = function(enums) {
	for (var j = 0; j < enums.length; j++) {
		this.addEnum(enums[j]);
	}
}

//Allow look-up of message IDs by name
mavlink.prototype.getMessageID = function(name) {
	if (this.messagesByName[name] !== undefined) {
		return this.messagesByName[name].$.id;
	}
	return -1;
}

//Allow look-up of message name from ID
mavlink.prototype.getMessageName = function(id) {
	if (this.messagesByID[id] !== undefined) {
		return this.messagesByID[id].$.name;
	}
	return "";
}

//Load definitions from the XML files
mavlink.prototype.loadDefinitions = function() {
	//Track how many files we've parsed
	var parsed = 0;

	//Loop over all definitions present, load them in turn
	for (var i = 0; i<this.definitions.length; i++) {
	
		//self invoking function to preserve loop values
		(function(self, i){
			if (DEBUG) {
				console.log("MAVLink: Reading " + self.definitions[i] + ".xml");
			}
			
			//Read the XML file and parse it when loaded
			fs.readFile(__dirname + '/mavlink/message_definitions/' + self.version + '/' + self.definitions[i] + '.xml', function(err, data) {
				
				//Pass XML data to the parser
				parser.parseString(data, function (err, result) {
					if (DEBUG) {
						console.log("MAVLink: Parsing " + self.definitions[i] + ".xml");
					}
					
					//Extract the arrays of enums and messages
					if (DEBUG) {
						console.log("MAVLink: " + self.definitions[i] + " enums");
					}
					self.addEnums(result['mavlink']['enums'][0]['enum']);

					if (DEBUG) {
						console.log("MAVLink: " + self.definitions[i] + " messages");
					}
					self.addMessages(result['mavlink']['messages'][0].message);
					
					//When all files has been parsed, emit event
					if (parsed++ == self.definitions.length-1) {
						self.emit("ready");
					}
				});
			});
		})(this,i); //Call of self invoking function
	}
};

//Function to determine the size of the fields data type
mavlink.prototype.fieldTypeLength = function(field) {
	//Define all the lengths
	var typeLengths = {
	'float'    : 4,
	'double'   : 8,
	'char'     : 1,
	'int8_t'   : 1,
	'uint8_t'  : 1,
	'uint8_t_mavlink_version'  : 1,
	'int16_t'  : 2,
	'uint16_t' : 2,
	'int32_t'  : 4,
	'uint32_t' : 4,
	'int64_t'  : 8,
	'uint64_t' : 8,
	}
	return typeLengths[field.$.type.replace("[", " ").replace("]", " ").split(" ")[0]];
}

//Function to determine the total size of a field ([type size] x [array size])
mavlink.prototype.fieldLength = function(field) {
	//Get the types size
	var typeLength = this.fieldTypeLength(field);
	
	//Split up the field name to find array size
	var fieldSplit = field.$.type.replace("[", " ").replace("]", " ").split(" ");
	
	//For each element after the type name (>1), multiply up
	for (var i = 1; i<fieldSplit.length; i++) {
		if (fieldSplit[i] != "") {
			typeLength *= fieldSplit[i];
		}
	}
	return typeLength;
}

//Order fields by type size
mavlink.prototype.orderFields = function(message) {

	message.payloadLength = 0;
	//First make a few corrections
	for (var i=0; i<message.field.length; i++) {
		//add initial position in XML to preserve this if sizes equal (see sort function below)
		message.field[i].initialPos = i;
		
		//change a few types
		if (message.field[i].$.type == 'uint8_t_mavlink_version') {
			message.field[i].$.type = 'uint8_t';
		}
		if (message.field[i].$.type == 'array') {
			message.field[i].$.type = 'int8_t';
		}
		
		//Calculate some useful lengths
		message.field[i].length = this.fieldLength(message.field[i]);
		message.field[i].typeLength = this.fieldTypeLength(message.field[i]);
		message.field[i].arrayLength = message.field[i].length/message.field[i].typeLength;
		message.payloadLength += message.field[i].length;
	}
	
	//Sort fields by type length
	message.field.sort(function(a, b){
		
		//Determine lengths of a and b
		var lenA = a.typeLength;
		var lenB = b.typeLength;
		
		//if lengths are equal, preserve initial ordering
		if (lenA == lenB) { 
			return a.initialPos - b.initialPos;
		} else {
		//otherwise reverse sort on size
			return lenB-lenA;
		}
	})
}

//Implementation of X25 checksum from mavutil.py
mavlink.prototype.calculateChecksum = function(buffer) {
	checksum = 0xffff;
	for (var i = 0; i < buffer.length; i++) {
		var tmp = buffer[i] ^ (checksum & 0xff);
		tmp = (tmp ^ (tmp<<4)) & 0xFF;
		checksum = (checksum>>8) ^ (tmp<<8) ^ (tmp<<3) ^ (tmp>>4);
		checksum = checksum & 0xFFFF;
	}
	return checksum;
}

//Determine message checksums, based on message name, field names, types and sizes
mavlink.prototype.calculateMessageChecksum = function(message) {
	//First order fields
	this.orderFields(message);
	
	var checksumString = message.$.name + " ";
	for (var i = 0; i < message.field.length; i++) {
		var type = message.field[i].$.type.replace("[", " ").replace("]", " ").split(" ");
		checksumString += type[0] + " ";
		checksumString += message.field[i].$.name + " ";
		if (type[1] !== undefined) {
			checksumString += String.fromCharCode(type[1]);
		}
	}

	var checksum = this.calculateChecksum(new Buffer(checksumString));
	return (checksum&0xFF) ^ (checksum>>8);
}


//Function to return start charater depending on version
mavlink.prototype.startCharacter = function() {
	if (this.version == "v1.0") {
		return 0xFE;
	} else if (this.version == "v0.9") {
		return 0x55;
	}
}

mavlink.prototype.parseChar = function(ch) {
	//If we have no data yet, look for start character
	if (this.bufferIndex == 0 && ch == this.startCharacter()) {
		this.buffer[this.bufferIndex] = ch;
		this.bufferIndex++;
		return;
	}
	
	//Determine packet length
	if (this.bufferIndex == 1) {
		this.buffer[this.bufferIndex] = ch;
		this.messageLength = ch;
		this.bufferIndex++;
		return;
	}
	
	//Receive everything else
	if (this.bufferIndex > 1 && this.bufferIndex < this.messageLength + 8) {
		this.buffer[this.bufferIndex] = ch;
		this.bufferIndex++;
	}
	
	//If we're at the end of the packet, see if it's valid
	if (this.bufferIndex == this.messageLength + 8) {
	
		if (this.version == "v1.0") {
			//Buffer for checksummable data
			var crc_buf = new Buffer(this.messageLength+6);
			this.buffer.copy(crc_buf,0,1,this.messageLength+6);
			
			//Add the message checksum on the end
			crc_buf[crc_buf.length-1] = this.messageChecksums[this.buffer[5]];
		} else {
			//Buffer for checksummable data
			var crc_buf = new Buffer(this.messageLength+5);
			this.buffer.copy(crc_buf,0,1,this.messageLength+6);
		}
		
		//Test the checksum
		if (this.calculateChecksum(crc_buf) == this.buffer.readUInt16LE(this.messageLength+6)) {
			//If checksum is good but sequence is screwed, fire off an event
			if (this.buffer[2] > 0 && this.buffer[2] - this.lastCounter != 1) {
				this.emit("sequenceError", this.buffer[2] - this.lastCounter - 1);
			}
			//update counter
			this.lastCounter = this.buffer[2];
			
			//use message object to parse headers
			var message = new mavlinkMessage(this.buffer);
			
			//if system and component ID's dont match, ignore message. Alternatively if zeros were specified we return everything.
			if ((this.sysid == 0 && this.compid == 0) || (message.system == this.sysid && message.component == this.compid)) {
				//fire an event with the message data
				this.emit("message", message);
				
				//fire additional event for specific message type
				this.emit(this.getMessageName(this.buffer[5]), message, this.decodeMessage(message));
			}
		} else {
			//If checksum fails, fire an event with some debugging information. Message ID, Message Checksum (XML), Calculated Checksum, Received Checksum
			this.emit("checksumFail", this.buffer[5], this.messageChecksums[this.buffer[5]], this.calculateChecksum(crc_buf), this.buffer.readUInt16LE(this.messageLength+6));
		}
		//We got a message, so reset things
		this.bufferIndex = 0;
		this.messageLength = 0;
	}
};

//Function to call parseChar on all characters in a buffer
mavlink.prototype.parse = function(buffer) {
	for (var i=0; i<buffer.length; i++) {
		this.parseChar(buffer[i]);
	}
}

//Function to place a fields value in to a message buffer
mavlink.prototype.bufferField = function(buf, offset, field, value) {
	//Split up the field name to see if it's an array
	//TODO: Add some functions to do this as it's used in a few places
	var fieldSplit = field.$.type.replace("[", " ").replace("]", " ").split(" ");
	
	//If field is not an array, make a temporary array  (size 1) and assign the value to its only element
	if (fieldSplit.length == 1) {
		var valueArr = Array(1);
		valueArr[0] = value; 
	} else { //otherwise copy the array
		var valueArr = value;
	}
	
	//For all the elements in the array, place the values in the buffer.
	//TODO: check sizes here, if input data is less than field size that's fine (with a warning?)
	//		but if input is bigger than field size this will probably corrupt the buffer
	for (var i = 0; i<valueArr.length; i++) {
	
		//Figure out the data and write as appropriate
		switch (fieldSplit[0]){
			case 'float':
				buf.writeFloatLE(Number(valueArr[i]),offset);
				break;
			case'double':
				buf.writeDoubleLE(Number(valueArr[i]),offset);
				break;
			case 'char':
				buf.writeUInt8(valueArr[i].charCodeAt(0),offset);
				break;
			case 'int8_t':
				buf.writeInt8(Number(valueArr[i]),offset);
				break;
			case 'uint8_t':
				buf.writeUInt8(Number(valueArr[i]),offset);
				break;
			case 'uint8_t_mavlink_version':
				buf.writeUInt8(Number(valueArr[i]),offset);
				break;
			case 'int16_t':
				buf.writeInt16LE(Number(valueArr[i]),offset);
				break;
			case 'uint16_t':
				buf.writeUInt16LE(Number(valueArr[i]),offset);
				break;
			case 'int32_t':
				buf.writeInt32LE(Number(valueArr[i]),offset);
				break;
			case 'uint32_t':
				buf.writeUInt32LE(Number(valueArr[i]),offset);
				break;
				
			//TODO: Add support for the 64bit types
			case 'int64_t':
				console.warn("No 64-bit Integer support yet!");
				//buf.writeFloatLE(value[i],offset);
				break;
			case 'uint64_t':
				console.warn("No 64-bit Integer support yet!");
				//buf.writeFloatLE(value[i],offset);
				break;
		}
		//Keep track of how far we've come
		offset += field.typeLength;
	}
}

//Decode an incomming message in to its individual fields
mavlink.prototype.decodeMessage = function(message) {
	
	//determine the fields
	var fields = this.messagesByID[message.id].field;
	
	//initialise the output object and buffer offset
	var values = new Object();
	var offset = 0;
	
	//loop over fields
	for (var i = 0; i<fields.length; i++) {
		//determine if field is an array
		var fieldSplit = fields[i].$.type.replace("[", " ").replace("]", " ").split(" ");
		
		//determine field name
		var fieldTypeName = fieldSplit[0];
		
		//if field is an array, initialise output array
		if (fieldSplit.length > 1) {
			values[fields[i].$.name] = new Array(fields[i].arrayLength);
		}
		
		//loop over all elements in field and read from buffer
		for (var j = 0; j<fields[i].arrayLength; j++) {
			var val = 0;
			switch (fieldTypeName){
				case 'float':
					val = message.payload.readFloatLE(offset);
					break;
				case'double':
					val = message.payload.readDoubleLE(offset);
					break;
				case 'char':
					val = message.payload.readUInt8(offset);
					break;
				case 'int8_t':
					val = message.payload.readInt8(offset);
					break;
				case 'uint8_t':
					val = message.payload.readUInt8(offset);
					break;
				case 'uint8_t_mavlink_version':
					val = message.payload.readUInt8(offset);
					break;
				case 'int16_t':
					val = message.payload.readInt16LE(offset);
					break;
				case 'uint16_t':
					val = message.payload.readUInt16LE(offset);
					break;
				case 'int32_t':
					val = message.payload.readInt32LE(offset);
					break;
				case 'uint32_t':
					val = message.payload.readUInt32LE(offset);
					break;
					
				//TODO: Add support for the 64bit types
				case 'int64_t':
					console.warn("No 64-bit Integer support yet!");
					//buf.writeFloatLE(value[i],offset);
					break;
				case 'uint64_t':
					//console.warn("No 64-bit Unsigned Integer support yet!");
					var val1 = message.payload.readUInt32LE(offset);
					var val2 = message.payload.readUInt32LE(offset+4);
					val = (val1<<32) + (val2);
					break;
			}
			
			//increment offset by field type size
			offset += fields[i].typeLength;
			
			//if field is an array, output in to array
			if (fieldSplit.length > 1) {
				values[fields[i].$.name][j] =  val;
			} else {
				values[fields[i].$.name] = val;
			}
		}
		//reconstruct char arrays in to strings
		if (fieldSplit.length > 1 && fieldTypeName == 'char') {
			values[fields[i].$.name] = (new Buffer(values[fields[i].$.name])).toString();
		}
	}
	return values;
}

//Function to creae a MAVLink message to send out
//Input either the numeric message id or name, and the data as a structure of field-name : value
//For example:
//		myMAV.createMessage("ATTITUDE", {
//		'time_boot_ms':30,
//		'roll':0.1,
//		'pitch':0.2,
//		'yaw':0.3,
//		'rollspeed':0.4,
//		'pitchspeed':0.5,
//		'yawspeed':0.6
//	}, callback);
mavlink.prototype.createMessage = function(msgid, data, cb) { 
	//if ID's are zero we can't send data
	if (this.sysid == 0 && this.compid == 0) {
		console.log("System and component ID's are zero, cannot create message!");
	}
	
	var id = msgid;
	
	//Is message id numerical? If not then look it up 
	if (isNaN(Number(msgid))) {
		id = this.getMessageID(msgid);
	}
	
	//Get the details of the message
	var message = this.messagesByID[id];
	if (message === undefined) {
		console.log("Message '" + msgid + "' does not exist!");
		return;
	}
	
	//Create a buffer for the payload and null fill it
	var payloadBuf = new Buffer(message.payloadLength);
	payloadBuf.fill('\0');
	
	//Loop over the fields in the message
	var offset = 0;
	for (var i = 0; i < message.field.length; i++) {
		//If we don't have data for a field quit out with an error
		if (data[message.field[i].$.name] === undefined) {
			console.log("MAVLink: No data supplied for '" + message.field[i].$.name + "'");
			return;
		}
		
		//If we have data, add it to the buffer
		this.bufferField(payloadBuf, offset, message.field[i], data[message.field[i].$.name]);
		
		//Increment the buffer offset with the total field size
		offset += message.field[i].length;
	}
	
	//Create a buffer for the entire message and null fill
	var msgBuf = new Buffer(message.payloadLength + 8);
	msgBuf.fill('\0');
	
	//Determine sequence number
	if (this.sequence++ == 255) {
		this.sequence = 0;
	}
	
	//Construct the header information
	msgBuf[0] = this.startCharacter();
	msgBuf[1] = message.payloadLength;
	msgBuf[2] = this.sequence;
	msgBuf[3] = this.sysid;
	msgBuf[4] = this.compid;
	msgBuf[5] = id;
	
	
	//Copy in the payload buffer
	payloadBuf.copy(msgBuf,6,0);
	
	//Calculate the CRC
	var crc_buf = new Buffer(message.payloadLength+6);
	msgBuf.copy(crc_buf,0,1,message.payloadLength+6);
	crc_buf[crc_buf.length-1] = this.messageChecksums[id];
	msgBuf.writeUInt16LE(this.calculateChecksum(crc_buf), message.payloadLength+6);
	
	var msgObj = new mavlinkMessage(msgBuf);
	
	cb(msgObj);
}

module.exports = mavlink;
