import { type FormEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { Spinner } from '@tale-ui/react/spinner';
import { Tooltip } from '@tale-ui/react/tooltip';

import BookmarkIcon from 'lucide-react/dist/esm/icons/bookmark';
import CopyIcon from 'lucide-react/dist/esm/icons/copy';

import { signalAddrbarOpen, type AddrbarMode } from '../../bridge/useAddrbar';
import {
  signalSidebarAddressBookmarkToggle,
  signalSidebarAddressCopy,
  signalSidebarAddressIdentity,
  useSidebarAddressBridge,
  type SidebarAddressScope,
} from '../../bridge/useSidebarAddress';
import { useSidebarAddressStore, type SidebarAddressSnapshot } from '../../state/sidebarAddress';
import './SidebarAddressBar.css';

const COPY_FEEDBACK_MS = 1400;

function bookmarkKey(snapshot: SidebarAddressSnapshot | null): string | null {
  if (!snapshot || snapshot.tabId === null || !snapshot.url) return null;
  return `${snapshot.tabId}:${snapshot.url}`;
}

function displayValue(snapshot: SidebarAddressSnapshot | null): string {
  return snapshot?.displayUrl || snapshot?.url || '';
}

function canUseScope(
  scope: SidebarAddressScope,
): scope is { windowId: number | null; bridgeToken: string } {
  return typeof scope.bridgeToken === 'string' && scope.bridgeToken.length > 0;
}

function anchorRectFor(element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function SidebarAddressBar() {
  const scope = useSidebarAddressBridge();
  const rowRef = useRef<HTMLFormElement>(null);
  const securityButtonRef = useRef<HTMLButtonElement>(null);
  const lastOpenAtRef = useRef(0);
  const lastHandledCopyResultIdRef = useRef(0);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const [copyFeedbackVisible, setCopyFeedbackVisible] = useState(false);
  const snapshot = useSidebarAddressStore((s) => s.snapshot);
  const pendingBookmarkToggleKey = useSidebarAddressStore((s) => s.pendingBookmarkToggleKey);
  const lastCopyResult = useSidebarAddressStore((s) => s.lastCopyResult);

  const clearCopyFeedbackTimer = useCallback(() => {
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
      copyFeedbackTimeoutRef.current = null;
    }
  }, []);

  const clearCopyFeedback = useCallback(() => {
    clearCopyFeedbackTimer();
    setCopyFeedbackVisible(false);
  }, [clearCopyFeedbackTimer]);

  useEffect(() => clearCopyFeedbackTimer, [clearCopyFeedbackTimer]);

  useEffect(() => {
    clearCopyFeedback();
  }, [clearCopyFeedback, snapshot?.snapshotToken, snapshot?.url]);

  useEffect(() => {
    if (!lastCopyResult?.success || lastCopyResult.id <= lastHandledCopyResultIdRef.current) {
      return;
    }
    lastHandledCopyResultIdRef.current = lastCopyResult.id;
    if (
      !snapshot ||
      lastCopyResult.tabId !== snapshot.tabId ||
      lastCopyResult.url !== snapshot.url ||
      lastCopyResult.snapshotToken !== snapshot.snapshotToken
    ) {
      return;
    }
    clearCopyFeedbackTimer();
    setCopyFeedbackVisible(true);
    copyFeedbackTimeoutRef.current = window.setTimeout(() => {
      setCopyFeedbackVisible(false);
      copyFeedbackTimeoutRef.current = null;
    }, COPY_FEEDBACK_MS);
  }, [clearCopyFeedbackTimer, lastCopyResult, snapshot]);

  const openAddressOverlay = useCallback(
    (mode: AddrbarMode, initialQuery = '', clipboardUrl = '') => {
      const anchorRect = anchorRectFor(rowRef.current);
      if (!anchorRect) return;
      const now = Date.now();
      if (now - lastOpenAtRef.current < 160) return;
      lastOpenAtRef.current = now;
      signalAddrbarOpen(
        mode,
        mode === 'newTab' ? initialQuery : initialQuery || snapshot?.url || '',
        {
          anchorRect,
          clipboardUrl,
        },
      );
    },
    [snapshot?.url],
  );

  const handleBeginEdit = useCallback(() => {
    openAddressOverlay('current', snapshot?.url || '');
  }, [openAddressOverlay, snapshot?.url]);

  const handleInputPointerDown = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handleBeginEdit();
    },
    [handleBeginEdit],
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      handleBeginEdit();
    },
    [handleBeginEdit],
  );

  const handleSecurityPress = useCallback(() => {
    if (!snapshot?.security.canOpenIdentity || !canUseScope(scope)) return;
    const rect = securityButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    signalSidebarAddressIdentity({
      ...scope,
      tabId: snapshot.tabId,
      url: snapshot.url,
      snapshotToken: snapshot.snapshotToken,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }, [scope, snapshot]);

  const handleBookmarkPress = useCallback(() => {
    if (!snapshot?.bookmark.canBookmark || !canUseScope(scope)) return;
    const key = bookmarkKey(snapshot);
    if (!key || pendingBookmarkToggleKey === key) return;
    useSidebarAddressStore.getState().setPendingBookmarkToggle(key);
    signalSidebarAddressBookmarkToggle({
      ...scope,
      tabId: snapshot.tabId,
      url: snapshot.url,
      snapshotToken: snapshot.snapshotToken,
      title: snapshot.title,
    });
  }, [pendingBookmarkToggleKey, scope, snapshot]);

  const handleCopyPress = useCallback(() => {
    if (!snapshot?.url || !canUseScope(scope)) return;
    signalSidebarAddressCopy({
      ...scope,
      tabId: snapshot.tabId,
      url: snapshot.url,
      snapshotToken: snapshot.snapshotToken,
    });
  }, [scope, snapshot]);

  const securityLabel = snapshot?.security.label || 'Site information';
  const bookmarkPending =
    pendingBookmarkToggleKey !== null && pendingBookmarkToggleKey === bookmarkKey(snapshot);
  const bookmarkLabel = snapshot?.bookmark.isBookmarked ? 'Remove bookmark' : 'Bookmark page';
  const copyLabel = 'Copy URL';
  const copyDisabled = !snapshot?.url || !canUseScope(scope);
  const securityKind = snapshot?.security.kind || 'unknown';

  return (
    <section className="bento-sidebar-address-bar" aria-label="Address bar">
      <form
        ref={rowRef}
        className="bento-sidebar-address-bar__row"
        data-loading={snapshot?.loading ? 'true' : 'false'}
        onSubmit={handleSubmit}
      >
        <Tooltip.Root delay={350}>
          <IconButton
            ref={securityButtonRef}
            variant="ghost"
            size="sm"
            aria-label={securityLabel}
            isDisabled={!snapshot?.security.canOpenIdentity}
            className="bento-sidebar-address-bar__security-button"
            data-security={securityKind}
            onPress={handleSecurityPress}
          >
            <span className="bento-sidebar-address-bar__security-glyph" aria-hidden="true" />
          </IconButton>
          <Tooltip.Popup placement="bottom" offset={6}>
            <Tooltip.Arrow />
            {snapshot?.security.tooltip || securityLabel}
          </Tooltip.Popup>
        </Tooltip.Root>
        <input
          className="bento-sidebar-address-bar__input"
          aria-label="Search or enter address"
          value={displayValue(snapshot)}
          placeholder="Search or enter address"
          readOnly
          onPointerDown={handleInputPointerDown}
          onFocus={handleBeginEdit}
          onClick={handleBeginEdit}
        />
        {snapshot?.loading ? (
          <span className="bento-sidebar-address-bar__loading" aria-hidden="true">
            <Spinner size="sm" label="Loading page" />
          </span>
        ) : null}
        <Tooltip.Root delay={0} isOpen={copyFeedbackVisible}>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={copyLabel}
            isDisabled={copyDisabled}
            className="bento-sidebar-address-bar__copy-button"
            onPress={handleCopyPress}
          >
            <Icon icon={CopyIcon} size="sm" />
          </IconButton>
          <Tooltip.Popup placement="bottom" offset={6}>
            <Tooltip.Arrow />
            Copied
          </Tooltip.Popup>
        </Tooltip.Root>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={bookmarkLabel}
          isDisabled={!snapshot?.bookmark.canBookmark || bookmarkPending}
          pending={bookmarkPending}
          className="bento-sidebar-address-bar__bookmark-button"
          data-bookmarked={snapshot?.bookmark.isBookmarked ? 'true' : 'false'}
          onPress={handleBookmarkPress}
        >
          <Icon icon={BookmarkIcon} size="sm" />
        </IconButton>
      </form>
    </section>
  );
}
