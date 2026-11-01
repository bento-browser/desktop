// Maps Firefox's bookmark tree to Bookmarks manager groups for the one-time import.
import { isImportableUrl } from './links';

type TreeNode = browser.bookmarks.BookmarkTreeNode;

export interface ImportedGroup {
  name: string;
  links: Array<{ url: string; title: string }>;
}

/**
 * One group per folder with direct http(s) bookmark children, in tree order. A nested
 * folder is named "Parent / Folder" after its immediate parent (the invisible tree root
 * has no title, so the built-in roots keep their own names). Links stop at `maxLinks` in
 * total, and a folder with none left gets no group.
 */
export function firefoxFolders(tree: TreeNode[], maxLinks: number): ImportedGroup[] {
  const groups: ImportedGroup[] = [];
  let remaining = maxLinks;

  const visit = (node: TreeNode, parentTitle: string): void => {
    if (!node.children) return;
    const title = node.title || 'Untitled folder';
    const links: ImportedGroup['links'] = [];
    for (const child of node.children) {
      if (remaining - links.length <= 0) break;
      if (!child.children && isImportableUrl(child.url)) {
        links.push({ url: child.url, title: child.title || child.url });
      }
    }
    if (links.length > 0) {
      remaining -= links.length;
      groups.push({ name: parentTitle ? `${parentTitle} / ${title}` : title, links });
    }
    for (const child of node.children) {
      if (remaining <= 0) return;
      visit(child, node.title);
    }
  };

  for (const root of tree) visit(root, '');
  return groups;
}
