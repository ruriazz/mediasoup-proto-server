import * as mediasoup from 'mediasoup';

// Environment-based configuration with optimized defaults
const createConfig = (): Config => {
  const isProduction = process.env.NODE_ENV === 'production';
  const announcedIP = process.env.ANNOUNCED_IP || '127.0.0.1';
  
  // Optimized codec configurations - prioritize modern codecs and reduce redundancy
  const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
    // High-quality audio codec
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      preferredPayloadType: 111,
    },
    // Primary video codec with optimized bitrate settings
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      preferredPayloadType: 96,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
    // VP9 for better quality and efficiency
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
      preferredPayloadType: 98,
      parameters: {
        'profile-id': 2,
        'x-google-start-bitrate': 1000,
      },
    },
    // H.264 baseline profile for maximum compatibility
    {
      kind: 'video',
      mimeType: 'video/h264',
      clockRate: 90000,
      preferredPayloadType: 102,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate': 1000,
      },
    },
  ];

  return {
    // HTTP Server
    httpPort: Number(process.env.HTTP_PORT) || 3000,
    httpIp: process.env.HTTP_IP || '0.0.0.0',

    // MediaSoup configuration
    mediasoup: {
      worker: {
        rtcMinPort: Number(process.env.RTC_MIN_PORT) || 10000,
        rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 10100,
        logLevel: (process.env.MEDIASOUP_LOG_LEVEL || (isProduction ? 'warn' : 'debug')) as mediasoup.types.WorkerLogLevel,
        logTags: [
          'info',
          'ice',
          'dtls',
          'rtp',
          'srtp',
          'rtcp',
          ...(isProduction ? [] : ['rtx', 'bwe', 'score', 'simulcast', 'svc', 'sctp']),
        ] as mediasoup.types.WorkerLogTag[],
      } satisfies mediasoup.types.WorkerSettings,

      router: { mediaCodecs },

      webRtcTransport: {
        listenInfos: [
          {
            protocol: 'udp' as const,
            ip: '0.0.0.0',
            announcedAddress: announcedIP,
          },
          {
            protocol: 'tcp' as const,
            ip: '0.0.0.0',
            announcedAddress: announcedIP,
          },
        ],
        maxIncomingBitrate: Number(process.env.MAX_INCOMING_BITRATE) || 1500000,
        initialAvailableOutgoingBitrate: Number(process.env.INITIAL_OUTGOING_BITRATE) || 1000000,
        minimumAvailableOutgoingBitrate: Number(process.env.MIN_OUTGOING_BITRATE) || 600000,
        maxSctpMessageSize: Number(process.env.MAX_SCTP_MESSAGE_SIZE) || 262144,
        sctpSendBufferSize: Number(process.env.SCTP_SEND_BUFFER_SIZE) || 262144,
      },
    },
  } as const;
};

interface Config {
  readonly httpPort: number;
  readonly httpIp: string;
  readonly mediasoup: {
    readonly worker: mediasoup.types.WorkerSettings;
    readonly router: { readonly mediaCodecs: readonly mediasoup.types.RtpCodecCapability[] };
    readonly webRtcTransport: {
      readonly listenInfos: readonly { protocol: 'udp' | 'tcp'; ip: string; announcedAddress: string }[];
      readonly maxIncomingBitrate: number;
      readonly initialAvailableOutgoingBitrate: number;
      readonly minimumAvailableOutgoingBitrate: number;
      readonly maxSctpMessageSize: number;
      readonly sctpSendBufferSize: number;
    };
  };
}

export const config = createConfig();
