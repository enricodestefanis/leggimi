declare module "markdown-it-task-lists";
declare module "markdown-it-footnote";

// Vite ?inline imports: the file's source as a string
declare module "*?inline" {
  const content: string;
  export default content;
}
