export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_PORT = 8886;
export const SERVER_VERSION = '3.1';

export const VIDEO_CODEC_OPTIONS = 'video_codec_options=i-frame-interval=1';
export const SEND_DUMMY_BYTE = 'send_dummy_byte=false';
export const SEND_DEVICE_META = 'send_device_meta=false';
export const TUNNEL_FORWARD = 'tunnel_forward=true';
export const CONTROL = 'control=true';
export const VIDEO_BIT_RATE = 'video_bit_rate=3500000';
export const MAX_FPS = 'max_fps=60';
export const MAX_SIZE = 'max_size=1280';
export const AUDIO = 'audio=false';

// Define the arguments array
export const ARGUMENTS = [
  SERVER_VERSION,
  VIDEO_CODEC_OPTIONS,
  SEND_DUMMY_BYTE,
  SEND_DEVICE_META,
  TUNNEL_FORWARD,
  CONTROL,
  VIDEO_BIT_RATE,
  MAX_FPS,
  MAX_SIZE,
  AUDIO,
];

export const SERVER_PROCESS_NAME = 'app_process';

export const ARGS_STRING = `/ ${SERVER_PACKAGE} ${ARGUMENTS.join(' ')} 2>&1 > /dev/null`;
