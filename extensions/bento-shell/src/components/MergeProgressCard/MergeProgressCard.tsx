import { useId, useMemo } from 'react';
import type { Ref } from 'react';
import { Button, IconButton, ProgressCircle, Text } from '@muxui/react';
import AlertCircle from 'lucide-react/dist/esm/icons/alert-circle';
import ArrowUpRight from 'lucide-react/dist/esm/icons/arrow-up-right';
import Check from 'lucide-react/dist/esm/icons/check';
import X from 'lucide-react/dist/esm/icons/x';
import { useExternalMergeStore } from '../../state/externalMerge';
import type { ThemeScopeAttributes } from '../../theme/themeScope';
import { useInvertedThemeScope } from '../../theme/useInvertedThemeScope';
import { BentoIcon } from '../primitives';
import { useCardPresence } from '../SidebarCards/useCardPresence';
import { mergeProgressCardModel } from './mergeProgressCardModel';
import { useRailTooltip } from './railTooltip';
import type { MergeProgressCardModel } from './mergeProgressCardModel';
import './MergeProgressCard.css';

export interface MergeProgressCardProps {
  /**
   * The sidebar is the narrow rail: the card is a round ring button with no text, and
   * its title and detail show in the chrome-side tooltip overlay beside it (railTooltip.ts;
   * a tooltip drawn in the rail's 52px frame would be clipped). The layout follows the
   * shell's own width in CSS; this only switches the activation and the tooltip, like the
   * footer buttons' tooltips follow the setting.
   */
  rail?: boolean;
  /** Opens the merge palette, which shows the import's progress while it runs. */
  onOpen: () => void;
}

const dismissResult = () => useExternalMergeStore.getState().dismissResult();

export interface MergeProgressCardViewProps extends MergeProgressCardProps {
  model: MergeProgressCardModel;
  /**
   * The card's own theme scope: the sidebar's theme in the opposite colour scheme
   * (useInvertedThemeScope). The card is a dark surface on a light sidebar and a light
   * one on a dark sidebar, and everything inside follows.
   */
  scope: ThemeScopeAttributes;
  /** The card is playing its exit; it ignores the pointer and unmounts when the fade ends. */
  exiting?: boolean;
  onDismiss: () => void;
  cardRef?: Ref<HTMLDivElement>;
}

/**
 * The card for one `model`. The whole card is one Mux Button that opens the merge
 * palette; the dismiss button is its sibling, not nested in it. The button is named by
 * the title and described by the detail and host lines, so a screen reader reads the
 * counts when the card is focused instead of hearing every tab.
 */
export function MergeProgressCardView({
  model,
  scope,
  rail = false,
  exiting = false,
  onOpen,
  onDismiss,
  cardRef,
}: MergeProgressCardViewProps) {
  const titleId = useId();
  const detailId = useId();
  const hostId = useId();

  // In the rail there is no room for the dismiss button: opening a finished card also
  // clears it.
  const activate = () => {
    onOpen();
    if (rail && model.dismissible) onDismiss();
  };
  const describedBy =
    [model.detail ? detailId : null, model.host ? hostId : null].filter(Boolean).join(' ') ||
    undefined;
  const tooltip = useRailTooltip(rail && !exiting, { label: model.title, detail: model.detail });
  const ringIcon = model.kind === 'done' ? Check : model.kind === 'failed' ? AlertCircle : null;

  return (
    <div
      ref={cardRef}
      className="bento-sidebar-card bento-merge-card"
      data-kind={model.kind}
      data-exiting={exiting ? '' : undefined}
      {...scope}
      {...tooltip}
    >
      <Button
        variant="ghost"
        className="bento-merge-card__main"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onActivate={activate}
      >
        <ProgressCircle.Root
          size="sm"
          value={model.percent}
          label={model.title}
          aria-hidden="true"
          className="bento-merge-card__ring"
        >
          <ProgressCircle.Track />
          {/* Three digits do not fit the ring, so a full one shows no text. */}
          {model.kind === 'active' && model.percent > 0 && model.percent < 100 && (
            <ProgressCircle.Value className="bento-merge-card__ring-value" />
          )}
          {ringIcon && (
            <BentoIcon
              icon={ringIcon}
              size="xs"
              strokeWidth={model.kind === 'done' ? 3 : undefined}
              className="bento-merge-card__ring-icon"
            />
          )}
        </ProgressCircle.Root>
        <span className="bento-merge-card__text">
          <Text id={titleId} variant="label" size="sm" truncate className="bento-merge-card__title">
            {model.title}
          </Text>
          {model.detail && (
            <Text
              id={detailId}
              variant="body"
              size="xs"
              color="muted"
              truncate
              className="bento-merge-card__detail"
            >
              {model.detail}
            </Text>
          )}
          {model.host && (
            <Text
              id={hostId}
              variant="body"
              size="xs"
              color="muted"
              truncate
              className="bento-merge-card__host"
            >
              {model.host}
            </Text>
          )}
        </span>
        {!model.dismissible && (
          <BentoIcon icon={ArrowUpRight} size="sm" className="bento-merge-card__go" />
        )}
      </Button>
      {model.dismissible && (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Dismiss"
          className="bento-merge-card__dismiss"
          onActivate={onDismiss}
        >
          <BentoIcon icon={X} size="sm" />
        </IconButton>
      )}
    </div>
  );
}

/**
 * The sidebar's merge progress card: a running session import, then how it ended,
 * until dismissed. Render it inside `SidebarCards`. Screen readers also get a polite
 * status that changes with the stage and the outcome, never with each tab.
 */
export function MergeProgressCard({ rail = false, onOpen }: MergeProgressCardProps) {
  const activeOperationId = useExternalMergeStore((s) => s.activeOperationId);
  const progress = useExternalMergeStore((s) => s.progress);
  const progressLog = useExternalMergeStore((s) => s.progressLog);
  const sourceName = useExternalMergeStore((s) => s.activeSourceName);
  const result = useExternalMergeStore((s) => s.result);
  const model = useMemo(
    () => mergeProgressCardModel({ activeOperationId, progress, progressLog, sourceName, result }),
    [activeOperationId, progress, progressLog, sourceName, result],
  );
  const { shown, exiting, ref } = useCardPresence(model);
  const scope = useInvertedThemeScope();

  return (
    <>
      <div role="status" className="bento-visually-hidden">
        {model?.announcement ?? ''}
      </div>
      {shown && (
        <MergeProgressCardView
          model={shown}
          scope={scope}
          rail={rail}
          exiting={exiting}
          onOpen={onOpen}
          onDismiss={dismissResult}
          cardRef={ref}
        />
      )}
    </>
  );
}
