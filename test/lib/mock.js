// Copyright 2013 SAP AG.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http: //www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an 
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the License for the specific 
// language governing permissions and limitations under the License.
'use strict';

var net = require('net');
var lib = require('./hdb').lib;
var util = lib.util;
var bignum = util.bignum;
var SegmentKind = lib.common.SegmentKind;
var FunctionCode = lib.common.FunctionCode;
var PartKind = lib.common.PartKind;
var MessageType = lib.common.MessageType;
var ResultSetAttributes = lib.common.ResultSetAttributes;
var Segment = lib.reply.Segment;

var Part = lib.reply.Part;
var Fields = lib.data[PartKind.AUTHENTICATION];
var MAX_PACKET_SIZE = lib.common.MAX_PACKET_SIZE;

var DATA = {};
DATA.executeDirect = require('../fixtures/mock.executeDirect');
DATA.fetch = require('../fixtures/mock.fetch');
DATA.prepare = require('../fixtures/mock.prepare');
DATA.execute = require('../fixtures/mock.execute');

exports.createServer = function createServer() {
  var server = module.exports = net.createServer();
  server.maxConnections = 1;
  server.on('connection', handleConnection);
  return server;
};

function handleConnection(socket) {
  /* jshint validthis:true */
  var server = this;
  var count = 0;
  var context = {
    sessionId: -1,
    packetCount: undefined,
    fetchNext: {}
  };
  socket.on('error', function onerror(err) {
    console.log('socket error', err);
  });
  socket.on('end', function onend() {
    server.close();
  });
  socket.on('data', function ondata(chunk) {
    if (!Buffer.isBuffer(chunk) || !chunk.length) {
      return;
    }
    if (count === 0) {
      count += 1;
      socket.write(chunk.slice(4, 4 + 8));
      return;
    }
    context.sessionId = bignum.readUInt64LE(chunk, 0);
    context.packetCount = chunk.readUInt32LE(8);
    handleMessage.call(socket, readMessage(chunk, 32), context);
  });
}

function isKind(part) {
  /* jshint validthis:true */
  return this === part.kind;
}

function handleMessage(msg, context) {
  /* jshint validthis:true */
  var segment;
  switch (msg.type) {
  case MessageType.AUTHENTICATE:
    segment = handleAuthenticate(msg);
    break;
  case MessageType.CONNECT:
    segment = handleConnect(msg);
    break;
  case MessageType.DISCONNECT:
    segment = handleDisconnect(msg);
    break;
  case MessageType.EXECUTE_DIRECT:
    segment = handleExecuteDirect(msg, context);
    break;
  case MessageType.FETCH_NEXT:
    segment = handleFetchNext(msg, context);
    break;
  case MessageType.PREPARE:
    segment = handlePrepare(msg, context);
    break;
  case MessageType.EXECUTE:
    segment = handleExecute(msg, context);
    break;
  case MessageType.DROP_STATEMENT_ID:
    segment = handleDropStatementID(msg, context);
    break;
  default:
    throw new Error('Message type ' + msg.type + ' not supported');
  }
  writeReply.call(this, context, segment.toBuffer());
}

function handleAuthenticate(msg) {
  /* jshint unused:false */
  var msgPart = msg.parts.filter(isKind.bind(PartKind.AUTHENTICATION))[0];
  var fields = Fields.read(msgPart);
  var user = fields[0];
  var algorithm = fields[1].toString('ascii');
  var salt = new Buffer([
    0x80, 0x96, 0x4f, 0xa8, 0x54, 0x28, 0xae, 0x3a,
    0x81, 0xac, 0xd3, 0xe6, 0x86, 0xa2, 0x79, 0x33
  ]);
  var serverChallenge = new Buffer([
    0x41, 0x06, 0x51, 0x50, 0x11, 0x7e, 0x45, 0x5f,
    0xec, 0x2f, 0x03, 0xf6, 0xf4, 0x7c, 0x19, 0xd4,
    0x05, 0xad, 0xe5, 0x0d, 0xd6, 0x57, 0x31, 0xdc,
    0x0f, 0xb3, 0xf7, 0x95, 0x4d, 0xb6, 0x2c, 0x8a,
    0xa6, 0x7a, 0x7e, 0x82, 0x5e, 0x13, 0x00, 0xbe,
    0xe9, 0x75, 0xe7, 0x45, 0x18, 0x23, 0x8c, 0x9a
  ]);
  var segment = new Segment(SegmentKind.REPLY, FunctionCode.NIL);
  var part = new Part(PartKind.AUTHENTICATION);
  Fields.write(part, [algorithm, [salt, serverChallenge]]);
  segment.push(part);
  return segment;
}


function handleDisconnect(msg) {
  /* jshint unused:false */
  var segment = new Segment(SegmentKind.REPLY, FunctionCode.DISCONNECT);
  return segment;
}

function handleConnect(msg) {
  /* jshint unused:false */
  var msgPart = msg.parts.filter(isKind.bind(PartKind.AUTHENTICATION))[0];
  var fields = Fields.read(msgPart);
  var user = fields[0];
  var algorithm = fields[1].toString('ascii');
  var serverProof = '';
  var segment = new Segment(SegmentKind.REPLY, FunctionCode.NIL);
  var part = new Part(PartKind.AUTHENTICATION);
  Fields.write(part, [
    fields[1],
    serverProof
  ]);
  segment.push(part);
  return segment;
}

function handleExecuteDirect(msg, context) {
  /* jshint bitwise: false */
  var msgPart = msg.parts.filter(isKind.bind(PartKind.COMMAND))[0];
  var command = lib.data[PartKind.COMMAND].read(msgPart);
  command = command.toLowerCase().replace(/\s+/g, ' ').trim();
  var resultSetId, isLast;
  var sd = DATA.executeDirect[command];
  var segment = new Segment(sd.kind, sd.functionCode);
  sd.parts.forEach(function addPart(p) {
    if (p.kind === PartKind.RESULT_SET_ID) {
      resultSetId = p.buffer.toString('hex');
    }
    if (p.kind === PartKind.RESULT_SET) {
      isLast = p.attributes & ResultSetAttributes.LAST;
    }
    segment.push(new Part(p.kind, p.attributes, p.argumentCount, p.buffer));
  });
  if (!isLast) {
    context.fetchNext[resultSetId] = 0;
  }
  return segment;
}

function handleFetchNext(msg, context) {
  /* jshint bitwise: false  */
  var msgPart = msg.parts.filter(isKind.bind(PartKind.RESULT_SET_ID))[0];
  var resultSetId = msgPart.buffer.toString('hex');
  var isLast;
  var sd = DATA.fetch[resultSetId][context.fetchNext[resultSetId]];
  var segment = new Segment(sd.kind, sd.functionCode);
  sd.parts.forEach(function addPart(p) {
    if (p.kind === PartKind.RESULT_SET) {
      isLast = p.attributes & ResultSetAttributes.LAST;
    }
    segment.push(new Part(p.kind, p.attributes, p.argumentCount, p.buffer));
  });
  if (!isLast) {
    context.fetchNext[resultSetId] += 1;
  } else {
    context.fetchNext[resultSetId] = undefined;
  }
  return segment;
}

function handlePrepare(msg) {
  var msgPart = msg.parts.filter(isKind.bind(PartKind.COMMAND))[0];
  var command = lib.data[PartKind.COMMAND].read(msgPart);
  command = command.toLowerCase().replace(/\s+/g, ' ').trim();
  var sd = DATA.prepare[command];
  var segment = new Segment(sd.kind, sd.functionCode);
  sd.parts.forEach(function addPart(p) {
    segment.push(new Part(p.kind, p.attributes, p.argumentCount, p.buffer));
  });
  return segment;
}

function handleExecute(msg) {
  var idPart = msg.parts.filter(isKind.bind(PartKind.STATEMENT_ID))[0];
  var statementId = idPart.buffer.toString('hex');
  var paramsPart = msg.parts.filter(isKind.bind(PartKind.PARAMETERS))[0];
  var params = paramsPart.buffer.toString('hex');
  var sd = DATA.execute[statementId][params];
  var segment = new Segment(sd.kind, sd.functionCode);
  sd.parts.forEach(function addPart(p) {
    segment.push(new Part(p.kind, p.attributes, p.argumentCount, p.buffer));
  });
  return segment;
}

function handleDropStatementID(msg) {
  /* jshint unused:false */
  var segment = new Segment(SegmentKind.REPLY, FunctionCode.NIL);
  return segment;
}

function readMessage(buffer, offset) {
  var numberOfParts = buffer.readUInt16LE(offset + 8);
  var message = {
    type: buffer[offset + 13],
    parts: []
  };
  offset += 24;
  var part, length;
  for (var i = 0; i < numberOfParts; i++) {
    length = buffer.readInt32LE(offset + 8);
    part = {
      kind: buffer[offset + 0],
      attributes: buffer[offset + 1],
      argumentCount: buffer.readInt16LE(offset + 2),
      buffer: new Buffer(length)
    };
    offset += 16;
    buffer.copy(part.buffer, 0, offset, offset + length);
    message.parts.push(part);
    offset += util.alignLength(length, 8);
  }
  return message;
}

function writeReply(context, replyBuffer) {
  /* jshint validthis:true */
  var buffer = new Buffer(32);
  // Session identifier
  bignum.writeInt64LE(buffer, context.sessionId, 0);
  // Packet sequence number in this session
  // Packets with the same sequence number belong to one request / reply pair
  buffer.writeInt32LE(context.packetCount, 8);
  // Used space in this packet
  buffer.writeInt32LE(replyBuffer.length, 12);
  // Total space in this buffer
  buffer.writeInt32LE(MAX_PACKET_SIZE, 16);
  // Number of segments in this packet
  buffer.writeInt16LE(1, 20);
  // Filler
  buffer.fill(0x00, 22);
  this.write(Buffer.concat([buffer, replyBuffer], 32 + replyBuffer.length));
}