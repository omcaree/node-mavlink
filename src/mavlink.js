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

mavlink.prototype.getCrcExtraForId  = function(id)
{
  var checksum = 0;
  switch (id) {
    case 0: checksum =  50; break;
    case 1: checksum =  124; break;
    case 2: checksum =  137; break;
    case 4: checksum =  237; break;
    case 5: checksum =  217; break;
    case 6: checksum =  104; break;
    case 7: checksum =  119; break;
    case 11: checksum =  89; break;
    case 20: checksum =  214; break;
    case 21: checksum =  159; break;
    case 22: checksum =  220; break;
    case 23: checksum =  168; break;
    case 24: checksum =  24; break;
    case 25: checksum =  23; break;
    case 26: checksum =  170; break;
    case 27: checksum =  144; break;
    case 28: checksum =  67; break;
    case 29: checksum =  115; break;
    case 30: checksum =  39; break;
    case 31: checksum =  246; break;
    case 32: checksum =  185; break;
    case 33: checksum =  104; break;
    case 34: checksum =  237; break;
    case 35: checksum =  244; break;
    case 36: checksum =  222; break;
    case 37: checksum =  212; break;
    case 38: checksum =  9; break;
    case 39: checksum =  254; break;
    case 40: checksum =  230; break;
    case 41: checksum =  28; break;
    case 42: checksum =  28; break;
    case 43: checksum =  132; break;
    case 44: checksum =  221; break;
    case 45: checksum =  232; break;
    case 46: checksum =  11; break;
    case 47: checksum =  153; break;
    case 48: checksum =  41; break;
    case 49: checksum =  39; break;
    case 50: checksum =  78; break;
    case 54: checksum =  15; break;
    case 55: checksum =  3; break;
    case 61: checksum =  153; break;
    case 62: checksum =  183; break;
    case 63: checksum =  51; break;
    case 64: checksum =  59; break;
    case 65: checksum =  118; break;
    case 66: checksum =  148; break;
    case 67: checksum =  21; break;
    case 69: checksum =  243; break;
    case 70: checksum =  124; break;
    case 73: checksum =  38; break;
    case 74: checksum =  20; break;
    case 75: checksum =  158; break;
    case 76: checksum =  152; break;
    case 77: checksum =  143; break;
    case 81: checksum =  106; break;
    case 82: checksum =  49; break;
    case 83: checksum =  22; break;
    case 84: checksum =  143; break;
    case 85: checksum =  140; break;
    case 86: checksum =  5; break;
    case 87: checksum =  150; break;
    case 89: checksum =  231; break;
    case 90: checksum =  183; break;
    case 91: checksum =  63; break;
    case 92: checksum =  54; break;
    case 100: checksum =  175; break;
    case 101: checksum =  102; break;
    case 102: checksum =  158; break;
    case 103: checksum =  208; break;
    case 104: checksum =  56; break;
    case 105: checksum =  93; break;
    case 106: checksum =  138; break;
    case 107: checksum =  108; break;
    case 108: checksum =  32; break;
    case 109: checksum =  185; break;
    case 110: checksum =  84; break;
    case 111: checksum =  34; break;
    case 112: checksum =  174; break;
    case 113: checksum =  124; break;
    case 114: checksum =  237; break;
    case 115: checksum =  4; break;
    case 116: checksum =  76; break;
    case 117: checksum =  128; break;
    case 118: checksum =  56; break;
    case 119: checksum =  116; break;
    case 120: checksum =  134; break;
    case 121: checksum =  237; break;
    case 122: checksum =  203; break;
    case 123: checksum =  250; break;
    case 124: checksum =  87; break;
    case 125: checksum =  203; break;
    case 126: checksum =  220; break;
    case 127: checksum =  25; break;
    case 128: checksum =  226; break;
    case 129: checksum =  46; break;
    case 130: checksum =  29; break;
    case 131: checksum =  223; break;
    case 132: checksum =  85; break;
    case 133: checksum =  6; break;
    case 134: checksum =  229; break;
    case 135: checksum =  203; break;
    case 136: checksum =  1; break;
    case 137: checksum =  195; break;
    case 138: checksum =  109; break;
    case 139: checksum =  168; break;
    case 140: checksum =  181; break;
    case 141: checksum =  47; break;
    case 142: checksum =  72; break;
    case 143: checksum =  131; break;
    case 146: checksum =  103; break;
    case 147: checksum =  154; break;
    case 148: checksum =  178; break;
    case 149: checksum =  200; break;
    case 241: checksum =  90; break;
    case 242: checksum =  104; break;
    case 243: checksum =  85; break;
    case 244: checksum =  95; break;
    case 245: checksum =  130; break;
    case 246: checksum =  158; break;
    case 248: checksum =  8; break;
    case 249: checksum =  204; break;
    case 250: checksum =  49; break;
    case 251: checksum =  170; break;
    case 252: checksum =  44; break;
    case 253: checksum =  83; break;
    case 254: checksum =  86; break;
    case 150: checksum =  134; break;
    case 151: checksum =  219; break;
    case 152: checksum =  208; break;
    case 153: checksum =  188; break;
    case 154: checksum =  84; break;
    case 155: checksum =  22; break;
    case 156: checksum =  19; break;
    case 157: checksum =  21; break;
    case 158: checksum =  134; break;
    case 160: checksum =  78; break;
    case 161: checksum =  68; break;
    case 162: checksum =  189; break;
    case 163: checksum =  127; break;
    case 164: checksum =  154; break;
    case 165: checksum =  21; break;
    case 166: checksum =  21; break;
    case 167: checksum =  144; break;
    case 168: checksum =  1; break;
    case 169: checksum =  234; break;
    case 170: checksum =  73; break;
    case 171: checksum =  181; break;
    case 172: checksum =  22; break;
    case 173: checksum =  83; break;
    case 174: checksum =  167; break;
    case 175: checksum =  138; break;
    case 176: checksum =  234; break;
    case 177: checksum =  240; break;
    case 178: checksum =  47; break;
    case 179: checksum =  189; break;
    case 180: checksum =  52; break;
    case 181: checksum =  174; break;
    case 182: checksum =  229; break;
    case 183: checksum =  85; break;
    case 184: checksum =  159; break;
    case 185: checksum =  186; break;
    case 186: checksum =  72; break;
    case 191: checksum =  92; break;
    case 192: checksum =  36; break;
    case 193: checksum =  71; break;
    case 194: checksum =  98; break;
    case 200: checksum =  134; break;
    case 201: checksum =  205; break;
    case 214: checksum =  69; break;
    case 215: checksum =  101; break;
    case 216: checksum =  50; break;
    case 217: checksum =  202; break;
    case 218: checksum =  17; break;
    case 219: checksum =  162; break;
    case 226: checksum =  207; break;
    default: checksum =  0; break;
  }
  return (checksum&0xFF) ^ (checksum>>8)
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
			
      if (this.buffer[5] == 42)
      {
        var rrr = 1
      }
        //Add the message checksum on the end
      //the messageChecksums for some messages (147-BATTERY_STATUS for example is not calculated correctly, so I added is hardcoded in getCrcExtraForId)
      //crc_buf[crc_buf.length-1] = this.messageChecksums[this.buffer[5]];
      var vvv = this.messageChecksums[this.buffer[5]];
      var val = this.getCrcExtraForId(this.buffer[5]);
      crc_buf[crc_buf.length-1] = (val&0xFF) ^ (val>>8)
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
  if (this.messagesByID[message.id] == undefined)
  {
    return;
  }
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
mavlink.prototype.createMessage = function(msgid, data, sysid, cb) { 
  //if ID's are zero we can't send data
  if (sysid == 0)
    sysid = this.sysid;
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
	msgBuf[3] = sysid;
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