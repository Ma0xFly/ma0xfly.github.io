export function postPath(entry: { id: string }) {
  return `/posts/${entry.id.replace(/\.(md|mdx)$/i, "")}/`;
}

