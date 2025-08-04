import { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { logger } from '../logger/logger';
import { mediaSoupServer } from '../sfu/mediasoupServer';
import { roomManager, Peer } from '../sfu/roomManager';
import { config } from '../config';

// Optimized type definitions for better performance and type safety
export interface SignalingCallback {
  (response: SignalingResponse): void;
}

export interface SignalingResponse {
  error?: string;
  [key: string]: unknown;
}

export interface JoinRoomData {
  roomId: string;
  peerId: string;
}

export interface CreateTransportData {
  producing?: boolean;
  consuming?: boolean;
  sctpCapabilities?: mediasoup.types.SctpCapabilities;
}

export interface ConnectTransportData {
  transportId: string;
  dtlsParameters: mediasoup.types.DtlsParameters;
}

export interface ProduceData {
  transportId: string;
  kind: mediasoup.types.MediaKind;
  rtpParameters: mediasoup.types.RtpParameters;
  appData?: Record<string, unknown>;
}

export interface ConsumeData {
  producerId: string;
  rtpCapabilities: mediasoup.types.RtpCapabilities;
  transportId?: string;
}

// Enhanced socket interface for better type safety
interface EnhancedSocket extends Socket {
  roomId?: string;
  peerId?: string;
}

export class SignalingServer {
  private readonly io: Server;
  // Optimized active speaker detection state
  private readonly activeSpeakerTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastActiveSpeaker = new Map<string, string>(); // roomId -> peerId
  private readonly audioLevels = new Map<string, Map<string, number>>(); // roomId -> peerId -> audioLevel
  
  // Constants for better performance
  private static readonly AUDIO_THRESHOLD = 0.01;
  private static readonly ACTIVE_SPEAKER_DEBOUNCE = 100; // ms

  constructor(io: Server) {
    this.io = io;
    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket: EnhancedSocket) => {
      logger.info(`Client connected [socketId:${socket.id}]`);

      // Bind event handlers efficiently using a handler map
      this.bindEventHandlers(socket);

      socket.on('error', (error) => {
        logger.error(`Socket error [socketId:${socket.id}]:`, error);
      });

      socket.on('disconnect', () => this.handleDisconnect(socket));
    });
  }

  private bindEventHandlers(socket: EnhancedSocket): void {
    // Optimized event handler mapping for better performance
    const eventHandlers = new Map<string, (...args: any[]) => void>([
      ['getRouterRtpCapabilities', (data: { roomId?: string }, callback: SignalingCallback) => 
        this.handleGetRouterRtpCapabilities(socket, data, callback)],
      ['joinRoom', (data: JoinRoomData, callback: SignalingCallback) => 
        this.handleJoinRoom(socket, data, callback)],
      ['createWebRtcTransport', (data: CreateTransportData, callback: SignalingCallback) => 
        this.handleCreateWebRtcTransport(socket, data, callback)],
      ['connectTransport', (data: ConnectTransportData, callback: SignalingCallback) => 
        this.handleConnectTransport(socket, data, callback)],
      ['produce', (data: ProduceData, callback: SignalingCallback) => 
        this.handleProduce(socket, data, callback)],
      ['consume', (data: ConsumeData, callback: SignalingCallback) => 
        this.handleConsume(socket, data, callback)],
      ['getProducers', (callback: SignalingCallback) => 
        this.handleGetProducers(socket, callback)],
      ['pauseProducer', (data: { producerId: string }, callback: SignalingCallback) => 
        this.handlePauseProducer(socket, data, callback)],
      ['resumeProducer', (data: { producerId: string }, callback: SignalingCallback) => 
        this.handleResumeProducer(socket, data, callback)],
      ['pauseConsumer', (data: { consumerId: string }, callback: SignalingCallback) => 
        this.handlePauseConsumer(socket, data, callback)],
      ['resumeConsumer', (data: { consumerId: string }, callback: SignalingCallback) => 
        this.handleResumeConsumer(socket, data, callback)],
      ['getTransportState', (data: { transportId: string }, callback: SignalingCallback) => 
        this.handleGetTransportState(socket, data, callback)],
      ['getConsumerStats', (data: { consumerId: string }, callback: SignalingCallback) => 
        this.handleGetConsumerStats(socket, data, callback)],
      ['leaveRoom', () => this.handleLeaveRoom(socket)],
      ['enableActiveSpeakerDetection', (callback: SignalingCallback) => 
        this.handleEnableActiveSpeakerDetection(socket, callback)],
      ['reportAudioLevel', (data: { audioLevel: number }, callback?: SignalingCallback) => 
        this.handleReportAudioLevel(socket, data, callback)],
    ]);

    // Register all event handlers efficiently
    for (const [event, handler] of eventHandlers) {
      socket.on(event, handler);
    }
  }

  private async handleGetRouterRtpCapabilities(
    socket: EnhancedSocket, 
    data: { roomId?: string }, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      let router: mediasoup.types.Router;
      
      if (data?.roomId) {
        // Get existing room router or create new room
        let room = roomManager.getRoom(data.roomId);
        if (!room) {
          router = await mediaSoupServer.createRouter();
          room = roomManager.createRoom(data.roomId, router);
          logger.info(`Room created for RTP capabilities [roomId:${data.roomId}]`);
        } else {
          router = room.router;
        }
      } else {
        // For general capabilities, create a temporary router
        router = await mediaSoupServer.createRouter();
      }
      
      callback({ rtpCapabilities: router.rtpCapabilities });
    } catch (error) {
      logger.error('Error getting router RTP capabilities:', error);
      callback({ error: 'Failed to get router RTP capabilities' });
    }
  }

  private async handleJoinRoom(
    socket: EnhancedSocket, 
    data: JoinRoomData, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = data;
      
      if (!roomId || !peerId) {
        callback({ error: 'Missing roomId or peerId' });
        return;
      }

      // Get or create room
      let room = roomManager.getRoom(roomId);
      if (!room) {
        const router = await mediaSoupServer.createRouter();
        room = roomManager.createRoom(roomId, router);
        logger.info(`Room created [roomId:${roomId}]`);
      }

      // Create and add peer
      const peer = roomManager.createPeer(peerId, socket);
      if (!roomManager.addPeerToRoom(roomId, peer)) {
        callback({ error: 'Failed to add peer to room' });
        return;
      }
      
      // Store room and peer info in socket
      socket.roomId = roomId;
      socket.peerId = peerId;
      peer.joined = true;

      logger.info(`Peer joined room [roomId:${roomId}, peerId:${peerId}]`);

      // Notify other peers and join socket room
      socket.to(roomId).emit('newPeer', { peerId });
      socket.join(roomId);

      callback({ success: true });
    } catch (error) {
      logger.error('Error joining room:', error);
      callback({ error: 'Failed to join room' });
    }
  }

  private async handleCreateWebRtcTransport(
    socket: EnhancedSocket, 
    data: CreateTransportData, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = socket;
      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const room = roomManager.getRoom(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      // Create WebRTC transport with optimized settings
      const transport = await room.router.createWebRtcTransport({
        listenInfos: [...config.mediasoup.webRtcTransport.listenInfos],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        enableSctp: Boolean(data.sctpCapabilities),
        numSctpStreams: data.sctpCapabilities?.numStreams || { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: config.mediasoup.webRtcTransport.maxSctpMessageSize,
        sctpSendBufferSize: config.mediasoup.webRtcTransport.sctpSendBufferSize,
        initialAvailableOutgoingBitrate: config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
      });

      // Store transport and setup event handlers
      if (!roomManager.addTransportToPeer(roomId, peerId, transport)) {
        transport.close();
        callback({ error: 'Failed to add transport to peer' });
        return;
      }

      this.setupTransportEventHandlers(transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      });

    } catch (error) {
      logger.error('Error creating WebRTC transport:', error);
      callback({ error: 'Failed to create WebRTC transport' });
    }
  }

  private setupTransportEventHandlers(transport: mediasoup.types.Transport): void {
    const webrtcTransport = transport as mediasoup.types.WebRtcTransport;
    
    webrtcTransport.on('dtlsstatechange', (dtlsState) => {
      logger.info(`Transport DTLS state changed [transportId:${transport.id}] state:${dtlsState}`);
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    webrtcTransport.on('icestatechange', (iceState) => {
      logger.debug(`Transport ICE state changed [transportId:${transport.id}] state:${iceState}`);
    });

    transport.once('@close', () => {
      logger.info(`Transport closed [transportId:${transport.id}]`);
    });
  }

  private async handleConnectTransport(
    socket: EnhancedSocket, 
    data: ConnectTransportData, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = socket;
      const { transportId, dtlsParameters } = data;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const transport = peer.transports.get(transportId);
      if (!transport) {
        callback({ error: 'Transport not found' });
        return;
      }

      await transport.connect({ dtlsParameters });
      callback({ success: true });
    } catch (error) {
      logger.error('Error connecting transport:', error);
      callback({ error: 'Failed to connect transport' });
    }
  }

  private async handleProduce(
    socket: EnhancedSocket, 
    data: ProduceData, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = socket;
      const { transportId, kind, rtpParameters, appData } = data;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const transport = peer.transports.get(transportId);
      if (!transport) {
        callback({ error: 'Transport not found' });
        return;
      }

      // Enhanced producer creation with optimized appData
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: {
          ...appData,
          peerId,
          roomId,
          // Optimize screen sharing detection
          isScreenShare: appData?.source === 'screen' || Boolean(appData?.isScreenShare),
        },
      });

      // Store producer and setup event handlers
      if (!roomManager.addProducerToPeer(roomId, peerId, producer)) {
        producer.close();
        callback({ error: 'Failed to add producer to peer' });
        return;
      }

      this.setupProducerEventHandlers(producer);

      // Optimized logging with minimal string operations
      const isScreenShare = Boolean(appData?.source === 'screen' || appData?.isScreenShare);
      const hasSimulcast = producer.kind === 'video' && 
        producer.rtpParameters.encodings && 
        producer.rtpParameters.encodings.length > 1;

      logger.info(
        `Producer created [producerId:${producer.id}, kind:${kind}${
          isScreenShare ? ', screenShare' : ''
        }${hasSimulcast ? ', simulcast' : ''}]`
      );

      // Efficient peer notification
      this.notifyPeersAboutNewProducer(roomId, peerId, producer, appData);

      callback({ id: producer.id });
    } catch (error) {
      logger.error('Error producing:', error);
      callback({ error: 'Failed to produce' });
    }
  }

  private setupProducerEventHandlers(producer: mediasoup.types.Producer): void {
    producer.once('transportclose', () => {
      logger.info(`Producer transport closed [producerId:${producer.id}]`);
    });
  }

  private notifyPeersAboutNewProducer(
    roomId: string, 
    peerId: string, 
    producer: mediasoup.types.Producer, 
    appData?: Record<string, unknown>
  ): void {
    const otherPeers = roomManager.getOtherPeersInRoom(roomId, peerId);
    
    // Early return if no peers to notify
    if (otherPeers.length === 0) return;

    // Pre-calculate notification data for efficiency
    const isScreenShare = Boolean(appData?.source === 'screen' || appData?.isScreenShare);
    const hasSimulcast = producer.kind === 'video' && 
      producer.rtpParameters.encodings && 
      producer.rtpParameters.encodings.length > 1;

    const notification = {
      peerId,
      producerId: producer.id,
      kind: producer.kind,
      paused: producer.paused,
      appData: {
        ...appData,
        isScreenShare,
        hasSimulcast,
      },
    };

    // Efficient batch notification to connected peers only
    let notifiedCount = 0;
    for (const otherPeer of otherPeers) {
      if (this.hasConnectedConsumerTransport(otherPeer)) {
        otherPeer.socket.emit('newProducer', notification);
        notifiedCount++;
      }
    }

    if (notifiedCount > 0) {
      logger.debug(
        `Notified ${notifiedCount} peers about new ${producer.kind} producer ${producer.id} from ${peerId}`
      );
    }
  }

  private hasConnectedConsumerTransport(peer: Peer): boolean {
    for (const transport of peer.transports.values()) {
      const webrtcTransport = transport as mediasoup.types.WebRtcTransport;
      if (webrtcTransport.dtlsState === 'connected') {
        return true;
      }
    }
    return false;
  }

  private async handleConsume(
    socket: EnhancedSocket, 
    data: ConsumeData, 
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = socket;
      const { producerId, rtpCapabilities, transportId } = data;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const room = roomManager.getRoom(roomId);
      const peer = roomManager.getPeerInRoom(roomId, peerId);
      
      if (!room || !peer) {
        callback({ error: 'Room or peer not found' });
        return;
      }

      // Find the producer
      const { producer, producerPeer } = this.findProducerInRoom(room, producerId);
      if (!producer || !producerPeer) {
        logger.warn(`Producer not found [producerId:${producerId}] in room [roomId:${roomId}]`);
        callback({ error: 'Producer not found' });
        return;
      }

      // Check if router can consume the producer
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        logger.warn(`Cannot consume producer [producerId:${producerId}] - RTP capabilities mismatch`);
        callback({ error: 'Cannot consume producer - RTP capabilities mismatch' });
        return;
      }

      // Find transport for consuming
      const transport = this.findConsumerTransport(peer, transportId);
      if (!transport) {
        callback({ error: transportId ? 'Specified transport not found' : 'No transport available for consuming' });
        return;
      }

      // Validate transport state
      const webrtcTransport = transport as mediasoup.types.WebRtcTransport;
      if (webrtcTransport.dtlsState === 'failed') {
        logger.error(`Transport failed for consuming [transportId:${transport.id}]`);
        callback({ 
          error: 'Transport failed',
          transportState: {
            dtlsState: webrtcTransport.dtlsState,
            iceState: webrtcTransport.iceState
          }
        });
        return;
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // Start paused as recommended
      });

      // Store consumer and setup event handlers
      if (!roomManager.addConsumerToPeer(roomId, peerId, consumer)) {
        consumer.close();
        callback({ error: 'Failed to add consumer to peer' });
        return;
      }

      this.setupConsumerEventHandlers(consumer, socket);

      logger.info(`Consumer created [consumerId:${consumer.id}, producerId:${producerId}] - PAUSED state for ${consumer.kind} from peer ${producerPeer.id}`);

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        paused: true,
        appData: {
          producerPeerId: producerPeer.id,
          consumerPeerId: peerId
        }
      });

    } catch (error) {
      logger.error('Error consuming:', error);
      callback({ error: 'Failed to consume' });
    }
  }

  private findProducerInRoom(room: { peers: Map<string, Peer> }, producerId: string): { producer?: mediasoup.types.Producer; producerPeer?: Peer } {
    for (const peer of room.peers.values()) {
      const producer = peer.producers.get(producerId);
      if (producer) {
        return { producer, producerPeer: peer };
      }
    }
    return {};
  }

  private findConsumerTransport(peer: Peer, transportId?: string): mediasoup.types.Transport | undefined {
    if (transportId) {
      return peer.transports.get(transportId);
    }
    
    // Find any available WebRTC transport
    return Array.from(peer.transports.values()).find(t => 
      t.constructor.name === 'WebRtcTransport'
    );
  }

  private setupConsumerEventHandlers(consumer: mediasoup.types.Consumer, socket: EnhancedSocket): void {
    consumer.once('transportclose', () => {
      logger.info(`Consumer transport closed [consumerId:${consumer.id}]`);
    });

    consumer.once('producerclose', () => {
      logger.info(`Consumer producer closed [consumerId:${consumer.id}]`);
      socket.emit('consumerClosed', { consumerId: consumer.id });
    });

    consumer.on('producerpause', () => {
      logger.info(`Consumer producer paused [consumerId:${consumer.id}]`);
      socket.emit('consumerPaused', { consumerId: consumer.id });
    });

    consumer.on('producerresume', () => {
      logger.info(`Consumer producer resumed [consumerId:${consumer.id}]`);
      socket.emit('consumerResumed', { consumerId: consumer.id });
    });

    consumer.on('layerschange', (layers) => {
      logger.debug(`Consumer layers changed [consumerId:${consumer.id}] layers:${JSON.stringify(layers)}`);
    });
  }

  private async handleGetProducers(socket: EnhancedSocket, callback: SignalingCallback): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const otherPeers = roomManager.getOtherPeersInRoom(roomId, peerId);
      const producers: Array<{ peerId: string; producerId: string; kind: string }> = [];

      for (const peer of otherPeers) {
        for (const producer of peer.producers.values()) {
          producers.push({
            peerId: peer.id,
            producerId: producer.id,
            kind: producer.kind,
          });
        }
      }

      callback({ producers });
    } catch (error) {
      logger.error('Error getting producers:', error);
      callback({ error: 'Failed to get producers' });
    }
  }

  // Producer control methods
  private async handlePauseProducer(socket: EnhancedSocket, data: { producerId: string }, callback: SignalingCallback): Promise<void> {
    await this.controlProducer(socket, data.producerId, 'pause', callback);
  }

  private async handleResumeProducer(socket: EnhancedSocket, data: { producerId: string }, callback: SignalingCallback): Promise<void> {
    await this.controlProducer(socket, data.producerId, 'resume', callback);
  }

  private async controlProducer(socket: EnhancedSocket, producerId: string, action: 'pause' | 'resume', callback: SignalingCallback): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const producer = peer.producers.get(producerId);
      if (!producer) {
        callback({ error: 'Producer not found' });
        return;
      }

      await producer[action]();
      callback({ success: true });
    } catch (error) {
      logger.error(`Error ${action}ing producer:`, error);
      callback({ error: `Failed to ${action} producer` });
    }
  }

  // Consumer control methods
  private async handlePauseConsumer(socket: EnhancedSocket, data: { consumerId: string }, callback: SignalingCallback): Promise<void> {
    await this.controlConsumer(socket, data.consumerId, 'pause', callback);
  }

  private async handleResumeConsumer(socket: EnhancedSocket, data: { consumerId: string }, callback: SignalingCallback): Promise<void> {
    await this.controlConsumer(socket, data.consumerId, 'resume', callback);
  }

  private async controlConsumer(socket: EnhancedSocket, consumerId: string, action: 'pause' | 'resume', callback: SignalingCallback): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const consumer = peer.consumers.get(consumerId);
      if (!consumer) {
        callback({ error: 'Consumer not found' });
        return;
      }

      await consumer[action]();
      
      if (action === 'resume') {
        logger.info(`Consumer resumed successfully [consumerId:${consumer.id}]`);
        callback({ success: true, resumed: true });
      } else {
        callback({ success: true });
      }
    } catch (error) {
      logger.error(`Error ${action}ing consumer:`, error);
      callback({ error: `Failed to ${action} consumer` });
    }
  }

  private async handleGetConsumerStats(socket: EnhancedSocket, data: { consumerId: string }, callback: SignalingCallback): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) {
        callback({ error: 'Consumer not found' });
        return;
      }

      const stats = await consumer.getStats();
      
      // Find transport that contains this consumer
      const webrtcTransport = Array.from(peer.transports.values())
        .find(t => t.constructor.name === 'WebRtcTransport') as mediasoup.types.WebRtcTransport | undefined;
      
      // Find inbound RTP stats
      const statsArray = Array.from(stats);
      const inboundRtp = statsArray.find((s: any) => s.type === 'inbound-rtp') as any;
      
      const result = { 
        stats: statsArray,
        paused: consumer.paused,
        closed: consumer.closed,
        kind: consumer.kind,
        producerId: consumer.producerId,
        transportState: webrtcTransport ? {
          id: webrtcTransport.id,
          dtlsState: webrtcTransport.dtlsState,
          iceState: webrtcTransport.iceState
        } : null,
        inboundBytes: inboundRtp?.bytesReceived || 0
      };
      
      logger.debug(`Consumer stats [consumerId:${consumer.id}] inboundBytes:${result.inboundBytes} paused:${result.paused}`);
      
      callback(result);
    } catch (error) {
      logger.error('Error getting consumer stats:', error);
      callback({ error: 'Failed to get consumer stats' });
    }
  }

  private async handleGetTransportState(socket: EnhancedSocket, data: { transportId: string }, callback: SignalingCallback): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      const peer = roomManager.getPeerInRoom(roomId, peerId);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const transport = peer.transports.get(data.transportId);
      if (!transport) {
        callback({ error: 'Transport not found' });
        return;
      }

      const webrtcTransport = transport as mediasoup.types.WebRtcTransport;
      
      callback({
        transportId: transport.id,
        dtlsState: webrtcTransport.dtlsState,
        iceState: webrtcTransport.iceState,
        connectionState: webrtcTransport.dtlsState === 'connected' ? 'connected' : 'connecting'
      });
    } catch (error) {
      logger.error('Error getting transport state:', error);
      callback({ error: 'Failed to get transport state' });
    }
  }

  private async handleLeaveRoom(socket: EnhancedSocket): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (roomId && peerId) {
        // Notify other peers
        socket.to(roomId).emit('peerLeft', { peerId });
        
        // Clean up active speaker detection data
        const roomAudioLevels = this.audioLevels.get(roomId);
        if (roomAudioLevels) {
          roomAudioLevels.delete(peerId);
          // Clean up room audio levels if empty
          if (roomAudioLevels.size === 0) {
            this.audioLevels.delete(roomId);
            this.lastActiveSpeaker.delete(roomId);
            const timer = this.activeSpeakerTimers.get(roomId);
            if (timer) {
              clearTimeout(timer);
              this.activeSpeakerTimers.delete(roomId);
            }
          }
        }
        
        // Remove peer from room
        roomManager.removePeerFromRoom(roomId, peerId);
        
        // Leave socket room
        socket.leave(roomId);
        
        logger.info(`Peer left room [roomId:${roomId}, peerId:${peerId}]`);
      }

      // Clear socket data
      delete socket.roomId;
      delete socket.peerId;
    } catch (error) {
      logger.error('Error leaving room:', error);
    }
  }

  private async handleDisconnect(socket: EnhancedSocket): Promise<void> {
    logger.info(`Client disconnected [socketId:${socket.id}]`);
    await this.handleLeaveRoom(socket);
  }

  // Active Speaker Detection functionality
  private async handleEnableActiveSpeakerDetection(
    socket: EnhancedSocket,
    callback: SignalingCallback
  ): Promise<void> {
    try {
      const { roomId, peerId } = socket;

      if (!roomId || !peerId) {
        callback({ error: 'Not in a room' });
        return;
      }

      logger.info(`Active speaker detection enabled [roomId:${roomId}, peerId:${peerId}]`);
      callback({ success: true });
    } catch (error) {
      logger.error('Error enabling active speaker detection:', error);
      callback({ error: 'Failed to enable active speaker detection' });
    }
  }

  private handleReportAudioLevel(
    socket: EnhancedSocket,
    data: { audioLevel: number },
    callback?: SignalingCallback
  ): void {
    try {
      const { roomId, peerId } = socket;
      const { audioLevel } = data;

      if (!roomId || !peerId) {
        if (callback) callback({ error: 'Not in a room' });
        return;
      }

      // Initialize audio levels for room if not exists
      if (!this.audioLevels.has(roomId)) {
        this.audioLevels.set(roomId, new Map());
      }

      const roomAudioLevels = this.audioLevels.get(roomId)!;
      roomAudioLevels.set(peerId, audioLevel);

      // Determine active speaker with optimized logic
      this.determineActiveSpeaker(roomId);

      if (callback) callback({ success: true });
    } catch (error) {
      logger.error('Error reporting audio level:', error);
      if (callback) callback({ error: 'Failed to report audio level' });
    }
  }

  private determineActiveSpeaker(roomId: string): void {
    const roomAudioLevels = this.audioLevels.get(roomId);
    if (!roomAudioLevels || roomAudioLevels.size === 0) return;

    // Find peer with highest audio level (above threshold)
    let activeSpeakerId: string | null = null;
    let maxAudioLevel = SignalingServer.AUDIO_THRESHOLD;

    for (const [peerId, audioLevel] of roomAudioLevels) {
      if (audioLevel > maxAudioLevel) {
        maxAudioLevel = audioLevel;
        activeSpeakerId = peerId;
      }
    }

    const currentActiveSpeaker = this.lastActiveSpeaker.get(roomId);

    // Only notify if active speaker changed (optimization)
    if (activeSpeakerId !== currentActiveSpeaker) {
      this.lastActiveSpeaker.set(roomId, activeSpeakerId || '');
      
      // Clear existing timer
      const existingTimer = this.activeSpeakerTimers.get(roomId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set debounced timer to avoid rapid changes
      const timer = setTimeout(() => {
        this.notifyActiveSpeakerChange(roomId, activeSpeakerId);
      }, SignalingServer.ACTIVE_SPEAKER_DEBOUNCE);

      this.activeSpeakerTimers.set(roomId, timer);
    }
  }

  private notifyActiveSpeakerChange(roomId: string, activeSpeakerId: string | null): void {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // Efficient batch notification to all peers
    const notification = {
      activeSpeakerId,
      timestamp: Date.now()
    };

    for (const peer of room.peers.values()) {
      peer.socket.emit('activeSpeakerChanged', notification);
    }

    logger.debug(`Active speaker changed [roomId:${roomId}, activeSpeakerId:${activeSpeakerId}]`);
  }
}
