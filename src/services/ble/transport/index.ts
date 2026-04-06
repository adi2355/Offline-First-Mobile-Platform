import { AppDeviceBLENative } from '../../../native/AppDeviceBLE';
export function shouldUseNativeTransport(): boolean {
  return AppDeviceBLENative.isAvailable();
}
