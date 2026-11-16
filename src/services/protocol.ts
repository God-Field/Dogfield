
export const cloudFunction = {
  updateAccount: 'update-account',
  createRoom: 'create-room',
} as const;

export const roomAction = {
  joinRoom: 'join-room',
  leaveRoom: 'leave-room',
  kickUser: 'kick-user',
  keepAlive: 'keep-alive',
  resetGame: 'reset-game',
  startGame: 'start-game',
  shuffleTeams: 'shuffle-teams',
  makeEntry: 'make-entry',
  cancelEntry: 'cancel-entry',
  setTiebreak: 'set-tiebreak',
  setRoomLocked: 'set-room-locked',
  submitCommand: 'submit-command',
  postMessage: 'post-message',
} as const;

export const firestoreDocument = {
  userCount: 'status/user_count',
  duelRankings: 'rankings/duel',
  records: (userId: string): string => `records/${userId}`,
  room: (mode: string, roomId: string): string => `modes/${mode}/rooms/${roomId}`,
  roomMessages: (roomId: string, audience: string): string => `modes/private/rooms/${roomId}/messages/${audience}`,
} as const;
