// Loading-state placeholder for the sidebar tab list. Rendered while we
// wait for both tabs/snapshot AND panels/sync (for the active workspace)
// to arrive from bento-tools. Without this gate the sidebar briefly
// shows the unfiltered tab list at boot — panels appear as tabs for one
// frame before panels/sync arrives and the filter pulls them out.
//
// Visual silhouette mirrors the static skeleton in index.html so the
// hand-off (static skeleton → React skeleton) is invisible. The shimmer
// animation lives in TabList.css alongside the row styles.
import './TabListSkeleton.css';

const ROW_COUNT = 6;

export function TabListSkeleton() {
  return (
    <div className="bento-tab-list-skeleton" aria-busy="true" aria-live="polite">
      {Array.from({ length: ROW_COUNT }).map((_, i) => (
        <div key={i} className="bento-tab-list-skeleton__row">
          <div className="bento-tab-list-skeleton__avatar" />
          <div className="bento-tab-list-skeleton__bar" />
        </div>
      ))}
    </div>
  );
}
