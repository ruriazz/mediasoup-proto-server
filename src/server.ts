import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { config } from './config';
import { logger } from './logger/logger';
import { mediaSoupServer } from './sfu/mediasoupServer';
import { SignalingServer } from './signaling/signaling';
import { roomManager } from './sfu/roomManager';

interface AppState {
  server?: ReturnType<typeof createServer>;
  io?: Server;
  signalingServer?: SignalingServer;
}

class MediaSoupSFUServer {
  private readonly state: AppState = {};

  async start(): Promise<void> {
    try {
      const app = this.createExpressApp();
      this.setupRoutes(app);
      
      const httpServer = createServer(app);
      this.state.server = httpServer;

      const io = this.createSocketIO(httpServer);
      this.state.io = io;

      await this.initializeServices(io);
      await this.startServer(httpServer);
      
      this.setupGracefulShutdown();
      
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  private createExpressApp(): express.Application {
    const app = express();
    
    // Optimized middleware configuration
    app.use(cors({
      origin: true,
      credentials: true,
    }));
    app.use(express.json({ limit: '1mb' }));
    
    return app;
  }

  private setupRoutes(app: express.Application): void {
    // Health check endpoint with enhanced stats
    app.get('/api/health', (req, res) => {
      const stats = {
        ...roomManager.getStats(),
        ...mediaSoupServer.getStats(),
      };
      
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        stats
      });
    });

    // Optimized room management endpoints
    app.get('/api/rooms', this.getRooms.bind(this));
    app.post('/api/rooms', this.createRoom.bind(this));
    app.get('/api/rooms/:roomId', this.getRoom.bind(this));
    app.delete('/api/rooms/:roomId', this.deleteRoom.bind(this));
  }

  // Optimized route handlers with consistent error handling
  private getRooms(req: express.Request, res: express.Response): void {
    try {
      const rooms = roomManager.getRoomsList();
      res.json({ rooms });
    } catch (error) {
      logger.error('Error getting rooms list:', error);
      res.status(500).json({ error: 'Failed to get rooms list' });
    }
  }

  private async createRoom(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { roomId } = req.body;
      
      // Input validation
      if (!roomId || typeof roomId !== 'string' || roomId.trim().length === 0) {
        res.status(400).json({ error: 'roomId is required and must be a non-empty string' });
        return;
      }

      const trimmedRoomId = roomId.trim();

      // Check if room already exists
      if (roomManager.getRoom(trimmedRoomId)) {
        res.status(409).json({ error: 'Room already exists' });
        return;
      }

      // Create new room with router
      const router = await mediaSoupServer.createRouter();
      const room = roomManager.createRoom(trimmedRoomId, router);

      logger.info(`Room created via API [roomId:${trimmedRoomId}]`);
      
      res.status(201).json({ 
        roomId: room.id,
        created: room.created,
        rtpCapabilities: router.rtpCapabilities
      });
    } catch (error) {
      logger.error('Error creating room:', error);
      res.status(500).json({ error: 'Failed to create room' });
    }
  }

  private getRoom(req: express.Request, res: express.Response): void {
    try {
      const { roomId } = req.params;
      const room = roomManager.getRoom(roomId);
      
      if (!room) {
        res.status(404).json({ error: 'Room not found' });
        return;
      }

      // Optimized peer data mapping
      const peers = Array.from(room.peers.values()).map(peer => ({
        id: peer.id,
        joined: peer.joined,
        joinedAt: peer.joinedAt,
        producersCount: peer.producers.size,
        consumersCount: peer.consumers.size,
      }));

      res.json({
        roomId: room.id,
        created: room.created,
        peersCount: room.peers.size,
        peers,
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } catch (error) {
      logger.error('Error getting room details:', error);
      res.status(500).json({ error: 'Failed to get room details' });
    }
  }

  private deleteRoom(req: express.Request, res: express.Response): void {
    try {
      const { roomId } = req.params;
      const deleted = roomManager.deleteRoom(roomId);
      
      if (!deleted) {
        res.status(404).json({ error: 'Room not found' });
        return;
      }

      logger.info(`Room deleted via API [roomId:${roomId}]`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Error deleting room:', error);
      res.status(500).json({ error: 'Failed to delete room' });
    }
  }

  private createSocketIO(httpServer: ReturnType<typeof createServer>): Server {
    return new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });
  }

  private async initializeServices(io: Server): Promise<void> {
    // Initialize MediaSoup server with optimal worker count
    logger.info('Initializing MediaSoup server...');
    const numWorkers = Number(process.env.WORKERS) || 1;
    await mediaSoupServer.init(numWorkers);

    // Initialize Signaling server
    logger.info('Initializing Signaling server...');
    this.state.signalingServer = new SignalingServer(io);
  }

  private async startServer(httpServer: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(config.httpPort, config.httpIp, () => {
        logger.info(`Server listening on ${config.httpIp}:${config.httpPort}`);
        logger.info('MediaSoup SFU Server is ready!');
        resolve();
      });
    });
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        // Close Socket.IO server
        if (this.state.io) {
          this.state.io.close();
        }
        
        // Cleanup rooms and peers
        roomManager.cleanup();
        
        // Close MediaSoup server
        await mediaSoupServer.close();
        
        // Close HTTP server
        if (this.state.server) {
          this.state.server.close(() => {
            logger.info('Server shutdown complete');
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Optimized error handling setup
function setupErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

// Application entry point
async function main(): Promise<void> {
  setupErrorHandlers();
  
  const server = new MediaSoupSFUServer();
  await server.start();
}

// Start the server
main().catch((error) => {
  logger.error('Failed to start application:', error);
  process.exit(1);
});
