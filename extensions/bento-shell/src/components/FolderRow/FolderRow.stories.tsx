import { FolderRow } from './FolderRow';
import { makeFolder } from '../../state/__fixtures__/tabFolders';
import './FolderRow.css';

export default {
  title: 'Components/FolderRow',
};

export function Expanded() {
  return (
    <FolderRow
      folder={makeFolder({ id: 'folder-1', workspaceId: 'ws-1', name: 'Research' })}
      tabCount={3}
    />
  );
}

export function Collapsed() {
  return (
    <FolderRow
      folder={makeFolder({
        id: 'folder-1',
        workspaceId: 'ws-1',
        name: 'Research',
        collapsed: true,
      })}
      tabCount={3}
    />
  );
}

export function LongName() {
  return (
    <div style={{ width: 180 }}>
      <FolderRow
        folder={makeFolder({
          id: 'folder-1',
          workspaceId: 'ws-1',
          name: 'Very long folder name that should truncate cleanly',
        })}
        tabCount={12}
      />
    </div>
  );
}
