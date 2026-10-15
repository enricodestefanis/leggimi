declare module "markdown-it-task-lists";
declare module "markdown-it-footnote";

// Vite ?raw imports: the file as a string (the localized help fragments)
declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite ?inline imports: the file's source as a string
declare module "*?inline" {
  const content: string;
  export default content;
}
