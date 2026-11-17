import { IconFeedback } from '../icons';
import { useFeedback } from './context';

/**
 * A quiet icon in the header of every screen that opens the feedback sheet.
 * It sits with the header's other icons, so it never covers the story or the
 * composer on a phone, and wears a dot when there is news on something sent.
 */
export function FeedbackButton() {
  const { enabled, unread, open } = useFeedback();
  if (!enabled) return null;
  return (
    <button
      type="button"
      className="icon-btn feedback-btn"
      onClick={open}
      aria-label={unread ? 'Feedback (new replies)' : 'Send feedback'}
      title="Send feedback"
    >
      <IconFeedback />
      {unread && <span className="feedback-dot" />}
    </button>
  );
}
