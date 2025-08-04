import * as mediasoup from 'mediasoup';
import { config } from '../config';
import { logger } from '../logger/logger';

export class MediaSoupServer {
  private readonly workers: mediasoup.types.Worker[] = [];
  private readonly routers = new Map<string, mediasoup.types.Router>();
  private nextWorkerIndex = 0;
  private isInitialized = false;

  async init(numWorkers = 1): Promise<void> {
    if (this.isInitialized) {
      logger.warn('MediaSoup server already initialized');
      return;
    }

    logger.info(`Initializing MediaSoup server with ${numWorkers} workers`);
    
    // Create workers in parallel for optimal startup performance
    const workerPromises = Array.from({ length: numWorkers }, (_, index) => 
      this.createWorker(index)
    );
    
    try {
      await Promise.all(workerPromises);
      this.isInitialized = true;
      logger.info(`MediaSoup server initialized with ${this.workers.length} workers`);
    } catch (error) {
      logger.error('Failed to initialize MediaSoup server:', error);
      await this.cleanup();
      throw error;
    }
  }

  private async createWorker(workerId: number): Promise<mediasoup.types.Worker> {
    try {
      const worker = await mediasoup.createWorker({
        ...config.mediasoup.worker,
        appData: { workerId },
      });

      // Set up optimized event handlers
      worker.on('died', (error) => {
        logger.error(`MediaSoup worker died [workerId:${workerId}]:`, error);
        this.handleWorkerDeath(workerId);
      });

      this.workers.push(worker);
      logger.info(`Worker created [pid:${worker.pid}, workerId:${workerId}]`);
      return worker;
    } catch (error) {
      logger.error(`Failed to create worker [workerId:${workerId}]:`, error);
      throw error;
    }
  }

  private handleWorkerDeath(workerId: number): void {
    logger.error(`Handling worker death [workerId:${workerId}]`);
    // In production, implement worker restart logic here
    // For now, graceful exit to prevent undefined behavior
    process.exit(1);
  }

  async createRouter(): Promise<mediasoup.types.Router> {
    if (!this.isInitialized || this.workers.length === 0) {
      throw new Error('MediaSoup server not initialized or no workers available');
    }

    const worker = this.getNextWorker();
    
    try {
      const router = await worker.createRouter({
        mediaCodecs: [...config.mediasoup.router.mediaCodecs],
      });

      const routerId = router.id;
      this.routers.set(routerId, router);

      // Optimize event handling with single 'workerclose' listener
      router.once('workerclose', () => {
        this.routers.delete(routerId);
        logger.warn(`Router closed [routerId:${routerId}]`);
      });

      logger.info(`Router created [routerId:${routerId}]`);
      return router;
    } catch (error) {
      logger.error('Failed to create router:', error);
      throw error;
    }
  }

  private getNextWorker(): mediasoup.types.Worker {
    if (this.workers.length === 0) {
      throw new Error('No workers available');
    }
    
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  getRouter(routerId: string): mediasoup.types.Router | undefined {
    return this.routers.get(routerId);
  }

  getRouters(): readonly mediasoup.types.Router[] {
    return Array.from(this.routers.values());
  }

  getRouterRtpCapabilities(routerId: string): mediasoup.types.RtpCapabilities | undefined {
    return this.routers.get(routerId)?.rtpCapabilities;
  }

  getStats(): { workersCount: number; routersCount: number } {
    return {
      workersCount: this.workers.length,
      routersCount: this.routers.size,
    };
  }

  async close(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    logger.info('Closing MediaSoup server');
    await this.cleanup();
    logger.info('MediaSoup server closed');
  }

  private async cleanup(): Promise<void> {
    // Close all routers first (they depend on workers)
    if (this.routers.size > 0) {
      const routerClosePromises = Array.from(this.routers.values()).map(router => 
        Promise.resolve(router.close())
      );
      await Promise.allSettled(routerClosePromises);
      this.routers.clear();
    }

    // Close all workers
    if (this.workers.length > 0) {
      const workerClosePromises = this.workers.map(worker => 
        Promise.resolve(worker.close())
      );
      await Promise.allSettled(workerClosePromises);
      this.workers.length = 0;
    }

    this.nextWorkerIndex = 0;
    this.isInitialized = false;
  }
}

export const mediaSoupServer = new MediaSoupServer();
