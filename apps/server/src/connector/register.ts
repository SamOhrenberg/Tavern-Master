// Every kind of request Claude can be handed registers its handler and tools
// here, by being imported. The connector imports this module once.
import { releaseClaims } from './work.js';
import { onRoomOpened } from '../realtime/room.js';

// A turn or request left alone past the claim timeout goes back to waiting.
onRoomOpened((room) => {
  room.onClaimsReleased = async () => {
    await releaseClaims(room.campaignId);
  };
});
