// Wrangler's default module rules bundle .html files as text.
declare module "*.html" {
  const content: string;
  export default content;
}
