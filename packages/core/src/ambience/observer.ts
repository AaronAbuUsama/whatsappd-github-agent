export interface AmbienceDispatchEvent {
  readonly windowId: string;
  readonly chatId: string;
  readonly dispatchId: string;
  readonly messageCount: number;
}

export interface AmbienceSpokeEvent {
  readonly chatId: string;
  readonly dispatchId: string;
  readonly text: string;
  readonly messageId?: string;
}

export interface AmbienceSettlementEvent {
  readonly windowId: string;
  readonly chatId: string;
  readonly dispatchId: string;
}

export interface AmbienceFailedEvent extends AmbienceSettlementEvent {
  readonly error: string;
}

/** Ratified application seam over Flue's dispatch-correlated lifecycle. */
export interface AmbienceObserver {
  windowDispatched(event: AmbienceDispatchEvent): void;
  spoke(event: AmbienceSpokeEvent): void;
  settledSilent(event: AmbienceSettlementEvent): void;
  settledFailed(event: AmbienceFailedEvent): void;
}
