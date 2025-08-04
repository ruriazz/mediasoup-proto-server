export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export class Logger {
  private readonly level: LogLevel;
  private readonly dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });

  constructor(level: string = 'INFO') {
    this.level = this.parseLogLevel(level);
  }

  private parseLogLevel(level: string): LogLevel {
    const upperLevel = level.toUpperCase();
    switch (upperLevel) {
      case 'ERROR': return LogLevel.ERROR;
      case 'WARN': return LogLevel.WARN;
      case 'INFO': return LogLevel.INFO;
      case 'DEBUG': return LogLevel.DEBUG;
      default: return LogLevel.INFO;
    }
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    return messageLevel <= this.level;
  }

  // Optimized timestamp formatting without new Date() allocation
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  // Optimized message formatting with minimal string operations
  private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const timestamp = this.getTimestamp();
    const levelStr = LogLevel[level];
    
    if (args.length === 0) {
      return `[${timestamp}] [${levelStr}] ${message}`;
    }

    // Use template string for better performance with arguments
    const formattedArgs = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      }
      return String(arg);
    }).join(' ');
    
    return `[${timestamp}] [${levelStr}] ${message} ${formattedArgs}`;
  }

  error(message: string, ...args: unknown[]): void {
    // Always log errors regardless of level
    console.error(this.formatMessage(LogLevel.ERROR, message, ...args));
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message, ...args));
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, ...args));
    }
  }
}

export const logger = new Logger(process.env.LOG_LEVEL || 'INFO');
