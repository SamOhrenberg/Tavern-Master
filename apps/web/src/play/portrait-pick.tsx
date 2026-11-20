import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { IconImage } from '../icons';
import { Avatar } from '../ui';
import { PortraitCropper, type Crop } from './portrait-crop';

/**
 * A picture being chosen in a form: a character's, or a person's or
 * creature's on the NPCs tab. What is chosen is only previewed until the form
 * is saved; the original file and its crop are kept so it can be cropped again.
 */
export function usePortraitPick(current: string | undefined) {
  const [picture, setPicture] = useState<{ blob: Blob; url: string; file: File; crop: Crop } | null>(null);
  const [drop, setDrop] = useState(false);
  const [cropping, setCropping] = useState<{ file: File; crop?: Crop } | null>(null);
  useEffect(
    () => () => {
      if (picture) URL.revokeObjectURL(picture.url);
    },
    [picture],
  );
  return {
    current,
    picture,
    cropping,
    /** What to show now: the new picture, nothing if it is being removed, or the one it had. */
    shown: picture?.url ?? (drop ? undefined : current),
    choose: (file: File) => setCropping({ file }),
    recrop: () => picture && setCropping({ file: picture.file, crop: picture.crop }),
    cancelCrop: () => setCropping(null),
    cropped: (blob: Blob, crop: Crop) => {
      if (cropping) setPicture({ blob, url: URL.createObjectURL(blob), file: cropping.file, crop });
      setDrop(false);
      setCropping(null);
    },
    remove: () => {
      setPicture(null);
      setDrop(true);
    },
    /** Send the change, if there is one, to the picture's address once what it belongs to exists. */
    save: async (path: string) => {
      if (picture) {
        const form = new FormData();
        form.append('file', picture.blob, 'portrait.jpg');
        await api(path, { method: 'PUT', form });
      } else if (drop && current) {
        await api(path, { method: 'DELETE' });
      }
    },
  };
}

export type PortraitPickState = ReturnType<typeof usePortraitPick>;

/** The picture at the top of a form, with buttons to choose, crop again and remove it. */
export function PortraitPick({ pick, name, seed }: { pick: PortraitPickState; name: string; seed: string }) {
  const picker = useRef<HTMLInputElement>(null);
  const open = () => picker.current?.click();
  return (
    <div className="portrait-pick">
      <button
        type="button"
        className="portrait-btn"
        onClick={open}
        aria-label={pick.shown ? 'Change the picture' : 'Add a picture'}
      >
        <Avatar name={name || '?'} seed={seed} src={pick.shown} large />
        <span className="portrait-badge" aria-hidden="true">
          <IconImage />
        </span>
      </button>
      <div className="portrait-acts">
        <button type="button" className="btn sm ghost" onClick={open}>
          {pick.shown ? 'Change picture' : 'Add a picture'}
        </button>
        {pick.picture && (
          <button type="button" className="btn sm ghost" onClick={pick.recrop}>
            Crop again
          </button>
        )}
        {pick.shown && (
          <button type="button" className="btn sm ghost" onClick={pick.remove}>
            Remove
          </button>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        className="sr-only"
        // The extensions too: Windows does not always know HEIC's type, and would hide the files.
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) pick.choose(file);
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      {pick.cropping && (
        <PortraitCropper
          file={pick.cropping.file}
          initial={pick.cropping.crop}
          onCancel={pick.cancelCrop}
          onDone={pick.cropped}
        />
      )}
    </div>
  );
}
