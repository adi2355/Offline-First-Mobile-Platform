export enum OtaState {
  IDLE = 'IDLE',
  CHECKING = 'CHECKING',
  READY = 'READY',
  STARTING = 'STARTING',
  ERASING = 'ERASING',
  RECEIVING = 'RECEIVING',
  VERIFYING = 'VERIFYING',
  COMPLETE = 'COMPLETE',
  REBOOTING = 'REBOOTING',
  VERIFIED = 'VERIFIED',
  ERROR = 'ERROR',
  ABORTED = 'ABORTED',
}
export type OtaEvent =
  | { type: 'BEGIN' }
  | { type: 'READY' }
  | { type: 'START_SESSION' }
  | { type: 'ERASE_COMPLETE' }
  | { type: 'CHUNK_COMMITTED' }
  | { type: 'VERIFYING' }
  | { type: 'COMPLETE' }
  | { type: 'REBOOTING' }
  | { type: 'VERIFIED' }
  | { type: 'ABORT' }
  | { type: 'RESET' }
  | { type: 'ERROR'; message: string };
const allowedTransitions: Record<OtaState, OtaEvent['type'][]> = {
  [OtaState.IDLE]: ['BEGIN', 'RESET'],
  [OtaState.CHECKING]: ['READY', 'ERROR', 'ABORT'],
  [OtaState.READY]: ['START_SESSION', 'ERROR', 'ABORT'],
  [OtaState.STARTING]: ['ERASE_COMPLETE', 'ERROR', 'ABORT'],
  [OtaState.ERASING]: ['ERASE_COMPLETE', 'ERROR', 'ABORT'],
  [OtaState.RECEIVING]: ['CHUNK_COMMITTED', 'VERIFYING', 'ERROR', 'ABORT'],
  [OtaState.VERIFYING]: ['COMPLETE', 'ERROR', 'ABORT'],
  [OtaState.COMPLETE]: ['REBOOTING', 'RESET'],
  [OtaState.REBOOTING]: ['VERIFIED', 'ERROR', 'ABORT'],
  [OtaState.VERIFIED]: ['RESET'],
  [OtaState.ERROR]: ['RESET'],
  [OtaState.ABORTED]: ['RESET'],
};
function assertTransition(current: OtaState, event: OtaEvent): void {
  const allowed = allowedTransitions[current];
  if (!allowed || !allowed.includes(event.type)) {
    throw new Error(`Invalid OTA transition: ${current} -> ${event.type}`);
  }
}
export class OtaStateMachine {
  private _state: OtaState = OtaState.IDLE;
  get state(): OtaState {
    return this._state;
  }
  transition(event: OtaEvent): OtaState {
    assertTransition(this._state, event);
    switch (event.type) {
      case 'BEGIN':
        this._state = OtaState.CHECKING;
        break;
      case 'READY':
        this._state = OtaState.READY;
        break;
      case 'START_SESSION':
        this._state = OtaState.STARTING;
        break;
      case 'ERASE_COMPLETE':
        this._state = OtaState.RECEIVING;
        break;
      case 'CHUNK_COMMITTED':
        this._state = OtaState.RECEIVING;
        break;
      case 'VERIFYING':
        this._state = OtaState.VERIFYING;
        break;
      case 'COMPLETE':
        this._state = OtaState.COMPLETE;
        break;
      case 'REBOOTING':
        this._state = OtaState.REBOOTING;
        break;
      case 'VERIFIED':
        this._state = OtaState.VERIFIED;
        break;
      case 'ABORT':
        this._state = OtaState.ABORTED;
        break;
      case 'RESET':
        this._state = OtaState.IDLE;
        break;
      case 'ERROR':
        this._state = OtaState.ERROR;
        break;
      default:
        return this._state;
    }
    return this._state;
  }
}
