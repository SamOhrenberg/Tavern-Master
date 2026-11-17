import { createContext, useContext } from 'react';

/** The feedback sheet, reachable from anywhere in the signed-in app. */
export interface FeedbackApi {
  /** False when the server has no GitHub repository set up: the button is not shown. */
  enabled: boolean;
  /** Replies or a closed issue the user has not seen yet. */
  unread: boolean;
  open: () => void;
}

export const FeedbackContext = createContext<FeedbackApi>({ enabled: false, unread: false, open: () => {} });

export const useFeedback = (): FeedbackApi => useContext(FeedbackContext);
