A Node.js module for encoding/decoding MAVLink messages
======================================================================

This module for Node.JS allows you to transmit and receive MAVLink encoded messages. [MAVLink](http://qgroundcontrol.org/mavlink/start) is a lightweight message marshalling system designed for Micro Aerial Vehicles (MAVs) which efficiently encodes data in to binary packets to be transmnitted over serial or network connection.

This module allows your application to communicate with other systems using MAVLink, such as the [Ardupilot Mega autopilot](http://store.3drobotics.com/products/apm-2-5-kit).

node-mavlink parses the XML based message definitions on initialisation and automatically decodes any incoming messages in to their corresponding fields. This allows you to utilise the MAVLink protocol from a node application without having to understand the its inner workings. 

Both MAVLink v0.9 and v1.0 are available, although v0.9 support is untested.

Installation
============

To install node-mavlink use

```
npm install mavlink
```

Usage
=====

Initialisation
--------------

To start decoding MAVLink messages you must create a new instance of node-mavlink for the particular System and Component ID's. For example,
```
var mavlink = require('mavlink');

var myMAV = new mavlink(1,1);
```

If you wish to receive all incoming messages, regardless of system and component IDs, set them both to 0. Note that if they are set to zero you will be unable to encode/send messages.

Additional arguments to the constructor are available to specify which version of MAVLink to use and which message definitions to load. A full constructor call would be
```
var myMAV = new mavlink(1,1,"v1.0",["common", "ardupilotmega"]);
```
This will use v1.0 and load the definition files common.xml and ardupilotmega.xml. Note that these are the default values if these arguments are ommitted.

You MUST wait for the "ready" event before attempting to use node-mavlink, see the Parsing Data section below.

Message Object
--------------
When receiving or creating messages, data is stored within a message object. The fields of this object are
 * length - The payload length
 * sequence - The sequence counter (loops from 0-255)
 * system - The system ID of the message origin
 * component - The component ID of the message origin
 * id - The numerical ID of the message
 * payload - Buffer containing the payload data
 * checksum - The message checksum (As transmitted)
 * buffer - Buffer containing the entire message, as required when transmitting the message
 
In addition to the message object, incoming data is automatically parsed in to individual fields. This is described in the next section.

Parsing Data
------------

You MUST wait for the "ready" event before attempting to use node-mavlink as the XML parsing can take a few seconds to complete. You can then begin parsing incoming data (from a serialport for example) and listening to messages
```
myMAV.on("ready", function() {
	//parse incoming serial data
	serialport.on('data', function(data) {
		myMAV.parse(data);
	});
	
	//listen for messages
	myMAV.on("message", function(message) {
		console.log(message);
	});
});
```

This will print out the object containing encoded message data as it arrives, these look something this...

```
{ length: 28,
  sequence: 24,
  system: 1,
  component: 1,
  id: 33,
  payload: <Buffer 8c 7d 51 00 00 00 00 00 00 00 00 00 28 17 02 00 00 00 00 00 00 00 00 00 00 00 00 00>,
  checksum: 44001,
  buffer: <Buffer fe 1c 18 01 01 21 8c 7d 51 00 00 00 00 00 00 00 00 00 28 17 02 00 00 00 00 00 00 00 00 00 00 00 00 00 e1 ab> }
```

You can also listen for specific messages, such as "ATTITUDE", this will return the encoded message as above, and the decoded fields. For example,
```
	myMAV.on("ATTITUDE", function(message, fields) {
		console.log(fields);
	});
```

This will print the decoded fields object

```
{ time_boot_ms: 1342833404,
  roll: -0.0003465251356828958,
  pitch: 0.004853600636124611,
  yaw: 0,
  rollspeed: 0.0016423191409558058,
  pitchspeed: 0.0016250653425231576,
  yawspeed: 0.003961517941206694 }
```

You can access these fields in the standard way, e.g.
```
	myMAV.on("ATTITUDE", function(message, fields) {
		console.log("Roll is " + fields.roll + "\nPitch is " + fields.pitch);
	});
```

Composing Messages
-----------------

To create a message you simply pass an object to the createMessage function along with a callback function which is executed upon completion, for example

```
	myMAV.createMessage("GPS_STATUS",
		{
		'satellites_visible':		5,
		'satellite_prn':			[1, 2, 3, 4, 5],
		'satellite_used':			[2, 3, 4, 5, 6],
		'satellite_elevation':		[3, 4, 5, 6, 7],
		'satellite_azimuth':		[4, 5, 6, 7, 8],
		'satellite_snr':			[5, 6, 7, 8, 9]
		},
		function(message) {
			serialport.write(message.buffer);
		});
```

Arrays need not be fully specified (e.g. in the above example the arrays are all defined at uint8_t[20]), all other elements will default to zero.

Events
------
The events emitted by node-mavlink are:

* "ready" - MAVLink message definitions have been loaded, node-mavlink can be used
* "sequenceError" - Two messages have been received sequentially whose sequence counter are not sequential (indicitive of data loss). The sequence mismatch is passed as an argument
* "message" - Valid message received. The corresponding message object is passed as argument.
* "checksumFail" - A message has been received but has failed the checksum. Various debugging information is passed as arguments, see mavlink.js for details

In addition to these events, each message received emits an event corresponding to the message type. For example on receipt of a GPS_RAW_INT message an event named "GPS_RAW_INT" is emitted. These events have both the message object passed as first argument along with an object containing the decoded fields. An example of this is given in the Parsing Data section above. 

These message specific events allow you to tailor certain behaviours to certain message types, whilst ignoring other messages. For example, updating the aim of a tracking antenna whenever new position information is available.