import type { DescriptionType } from "node-datachannel";

export type SignalingPeerInfo = {
  clientId: string;
  connectedAt: number;
};

export type SignalingJoinMessage = {
  type: "join";
  roomId: string;
  clientId: string;
};

export type SignalingSignalPayload =
  | {
      type: "description";
      descriptionType: DescriptionType;
      sdp: string;
    }
  | {
      type: "candidate";
      candidate: string;
      mid: string;
    };

export type SignalingSignalMessage = {
  type: "signal";
  roomId: string;
  clientId: string;
  targetClientId: string;
  signal: SignalingSignalPayload;
};

export type SignalingClientMessage = SignalingJoinMessage | SignalingSignalMessage;

export type SignalingJoinedMessage = {
  type: "joined";
  roomId: string;
  clientId: string;
  peers: SignalingPeerInfo[];
};

export type SignalingPeerJoinedMessage = {
  type: "peerJoined";
  roomId: string;
  peer: SignalingPeerInfo;
  peers: SignalingPeerInfo[];
};

export type SignalingPeerLeftMessage = {
  type: "peerLeft";
  roomId: string;
  clientId: string;
  peers: SignalingPeerInfo[];
};

export type SignalingErrorMessage = {
  type: "error";
  message: string;
};

export type SignalingServerMessage =
  | SignalingJoinedMessage
  | SignalingPeerJoinedMessage
  | SignalingPeerLeftMessage
  | SignalingSignalMessage
  | SignalingErrorMessage;

export function isSignalingClientMessage(value: unknown): value is SignalingClientMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SignalingClientMessage>;
  if (candidate.type === "join") {
    return typeof candidate.roomId === "string" && typeof candidate.clientId === "string";
  }

  if (candidate.type === "signal") {
    return (
      typeof candidate.roomId === "string" &&
      typeof candidate.clientId === "string" &&
      typeof candidate.targetClientId === "string" &&
      isSignalingSignalPayload(candidate.signal)
    );
  }

  return false;
}

export function isSignalingServerMessage(value: unknown): value is SignalingServerMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SignalingServerMessage>;
  if (candidate.type === "joined") {
    return (
      typeof candidate.roomId === "string" &&
      typeof candidate.clientId === "string" &&
      Array.isArray(candidate.peers)
    );
  }

  if (candidate.type === "peerJoined") {
    return typeof candidate.roomId === "string" && Boolean(candidate.peer) && Array.isArray(candidate.peers);
  }

  if (candidate.type === "peerLeft") {
    return typeof candidate.roomId === "string" && typeof candidate.clientId === "string" && Array.isArray(candidate.peers);
  }

  if (candidate.type === "signal") {
    return isSignalingClientMessage(candidate);
  }

  if (candidate.type === "error") {
    return typeof candidate.message === "string";
  }

  return false;
}

function isSignalingSignalPayload(value: unknown): value is SignalingSignalPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SignalingSignalPayload>;
  if (candidate.type === "description") {
    return typeof candidate.sdp === "string" && isDescriptionType(candidate.descriptionType);
  }

  if (candidate.type === "candidate") {
    return typeof candidate.candidate === "string" && typeof candidate.mid === "string";
  }

  return false;
}

function isDescriptionType(value: unknown): value is DescriptionType {
  return value === "offer" || value === "answer" || value === "pranswer" || value === "rollback" || value === "unspec";
}
