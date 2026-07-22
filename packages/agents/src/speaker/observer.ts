export interface SpeakerDispatchEvent {
  readonly windowId: string;
  readonly chatId: string;
  readonly dispatchId: string;
  readonly messageCount: number;
}

export interface SpeakerSpokeEvent {
  readonly chatId: string;
  readonly dispatchId: string;
  readonly text: string;
  readonly messageId?: string;
}

export interface SpeakerSettlementEvent {
  readonly windowId: string;
  readonly chatId: string;
  readonly dispatchId: string;
}

export interface SpeakerFailedEvent extends SpeakerSettlementEvent {
  readonly error: string;
}

/** Ratified application seam over Flue's dispatch-correlated lifecycle. */
export interface SpeakerObserver {
  windowDispatched(event: SpeakerDispatchEvent): void;
  spoke(event: SpeakerSpokeEvent): void;
  settledSilent(event: SpeakerSettlementEvent): void;
  settledFailed(event: SpeakerFailedEvent): void;
}

export interface DirectiveDispatchEvent {
  readonly directiveId: string;
  readonly surfaceId: string;
  readonly dispatchId: string;
}

export interface DirectiveFailedEvent extends DirectiveDispatchEvent {
  readonly error: string;
}

/** Lifecycle of one Speaker run admitted from a Brain Directive. */
export interface DirectiveObserver {
  dispatched(event: DirectiveDispatchEvent): void;
  settledWithoutSay(event: DirectiveDispatchEvent): void;
  settledFailed(event: DirectiveFailedEvent): void;
}
