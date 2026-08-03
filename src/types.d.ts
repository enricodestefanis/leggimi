declare module "markdown-it-task-lists";

// Vite ?inline imports: the file's source as a string
declare module "*?inline" {
  const content: string;
  export default content;
}
