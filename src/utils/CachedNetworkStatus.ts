import NetInfo, { type NetInfoSubscription, type NetInfoState } from '@react-native-community/netinfo';
export class CachedNetworkStatus {
  private _isOnline = true; 
  private _subscription: NetInfoSubscription | null = null;
  constructor() {
    this._subscription = NetInfo.addEventListener((state: NetInfoState) => {
      this._isOnline = state.isConnected === true;
    });
    NetInfo.fetch().then((state: NetInfoState) => {
      this._isOnline = state.isConnected === true;
    }).catch(() => {
    });
  }
  isOnline(): boolean {
    return this._isOnline;
  }
  dispose(): void {
    if (this._subscription != null) {
      this._subscription();
      this._subscription = null;
    }
  }
}
