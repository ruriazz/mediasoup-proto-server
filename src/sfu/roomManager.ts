import { Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';

export interface Peer {
  readonly id: string;
  readonly socket: Socket;
  readonly transports: Map<string, mediasoup.types.Transport>;
  readonly producers: Map<string, mediasoup.types.Producer>;
  readonly consumers: Map<string, mediasoup.types.Consumer>;
  rtpCapabilities?: mediasoup.types.RtpCapabilities;
  joined: boolean;
  readonly joinedAt: Date;
}

export interface Room {
  readonly id: string;
  readonly router: mediasoup.types.Router;
  readonly peers: Map<string, Peer>;
  readonly created: Date;
}

export interface RoomSummary {
  readonly roomId: string;
  readonly peerCount: number;
  readonly created: Date;
}

// Optimized constants for better performance
const EMPTY_ROOM_CLEANUP_DELAY = 60_000; // 1 minute
const EMPTY_PEER_ARRAY: readonly Peer[] = Object.freeze([]);

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly cleanupTimeouts = new Map<string, NodeJS.Timeout>();

  createRoom(roomId: string, router: mediasoup.types.Router): Room {
    if (this.rooms.has(roomId)) {
      throw new Error(`Room ${roomId} already exists`);
    }

    const room: Room = {
      id: roomId,
      router,
      peers: new Map(),
      created: new Date(),
    };

    this.rooms.set(roomId, room);
    this.cancelCleanupTimeout(roomId);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  deleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Efficient batch cleanup
    this.cleanupRoomResources(room);
    this.cancelCleanupTimeout(roomId);
    return this.rooms.delete(roomId);
  }

  private cleanupRoomResources(room: Room): void {
    // Cleanup all peers efficiently using batch operations
    const peers = Array.from(room.peers.values());
    for (const peer of peers) {
      this.cleanupPeerResources(peer);
    }
    room.peers.clear();

    // Close router
    room.router.close();
  }

  addPeerToRoom(roomId: string, peer: Peer): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.peers.set(peer.id, peer);
    this.cancelCleanupTimeout(roomId);
    return true;
  }

  removePeerFromRoom(roomId: string, peerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const peer = room.peers.get(peerId);
    if (!peer) return false;

    // Cleanup peer resources and remove from room
    this.cleanupPeerResources(peer);
    const removed = room.peers.delete(peerId);
    
    // Schedule cleanup if room becomes empty
    if (removed && room.peers.size === 0) {
      this.scheduleRoomCleanup(roomId);
    }

    return removed;
  }

  private cleanupPeerResources(peer: Peer): void {
    // Close all transports efficiently
    for (const transport of peer.transports.values()) {
      transport.close();
    }
    
    // Clear maps to free memory
    peer.transports.clear();
    peer.producers.clear();
    peer.consumers.clear();
  }

  private scheduleRoomCleanup(roomId: string): void {
    this.cancelCleanupTimeout(roomId);
    
    const timeout = setTimeout(() => {
      const room = this.rooms.get(roomId);
      if (room && room.peers.size === 0) {
        this.deleteRoom(roomId);
      }
    }, EMPTY_ROOM_CLEANUP_DELAY);
    
    this.cleanupTimeouts.set(roomId, timeout);
  }

  private cancelCleanupTimeout(roomId: string): void {
    const timeout = this.cleanupTimeouts.get(roomId);
    if (timeout) {
      clearTimeout(timeout);
      this.cleanupTimeouts.delete(roomId);
    }
  }

  getPeerInRoom(roomId: string, peerId: string): Peer | undefined {
    return this.rooms.get(roomId)?.peers.get(peerId);
  }

  getAllPeersInRoom(roomId: string): readonly Peer[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.peers.values()) : EMPTY_PEER_ARRAY;
  }

  getRoomsList(): readonly RoomSummary[] {
    return Array.from(this.rooms.entries()).map(([roomId, room]) => ({
      roomId,
      peerCount: room.peers.size,
      created: room.created,
    }));
  }

  createPeer(peerId: string, socket: Socket): Peer {
    return {
      id: peerId,
      socket,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      joined: false,
      joinedAt: new Date(),
    };
  }

  // Optimized peer resource management methods
  addTransportToPeer(roomId: string, peerId: string, transport: mediasoup.types.Transport): boolean {
    const peer = this.getPeerInRoom(roomId, peerId);
    if (!peer) return false;
    
    peer.transports.set(transport.id, transport);
    return true;
  }

  addProducerToPeer(roomId: string, peerId: string, producer: mediasoup.types.Producer): boolean {
    const peer = this.getPeerInRoom(roomId, peerId);
    if (!peer) return false;
    
    peer.producers.set(producer.id, producer);
    return true;
  }

  addConsumerToPeer(roomId: string, peerId: string, consumer: mediasoup.types.Consumer): boolean {
    const peer = this.getPeerInRoom(roomId, peerId);
    if (!peer) return false;
    
    peer.consumers.set(consumer.id, consumer);
    return true;
  }

  getOtherPeersInRoom(roomId: string, excludePeerId: string): readonly Peer[] {
    const room = this.rooms.get(roomId);
    if (!room) return EMPTY_PEER_ARRAY;

    // Optimized filtering with early return for empty room
    if (room.peers.size <= 1) return EMPTY_PEER_ARRAY;

    return Array.from(room.peers.values()).filter(peer => 
      peer.id !== excludePeerId && peer.joined
    );
  }

  // Optimized stats calculation
  getStats(): { totalRooms: number; totalPeers: number } {
    let totalPeers = 0;
    for (const room of this.rooms.values()) {
      totalPeers += room.peers.size;
    }
    
    return {
      totalRooms: this.rooms.size,
      totalPeers,
    };
  }

  // Enhanced cleanup for graceful shutdown
  cleanup(): void {
    // Clear all cleanup timeouts efficiently
    for (const timeout of this.cleanupTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.cleanupTimeouts.clear();

    // Close all rooms efficiently using batch operations
    for (const roomId of Array.from(this.rooms.keys())) {
      this.deleteRoom(roomId);
    }
  }
}

export const roomManager = new RoomManager();
