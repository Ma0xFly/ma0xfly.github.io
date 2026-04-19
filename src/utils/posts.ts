import postsData from "../generated/posts.json";

export type GeneratedPost = {
  id: string;
  slug: string;
  title: string;
  date: string;
  tags: string[];
  cover: string | null;
  summary: string;
  sourceNote: string;
  topLevel: string;
  directory: string;
  body: string;
  updated: string | null;
  publishedAt: string | null;
};

const posts = postsData as GeneratedPost[];

export default posts;

