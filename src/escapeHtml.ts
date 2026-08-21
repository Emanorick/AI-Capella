/**
 * Escapes text destined for an innerHTML template. Song titles and part names come from imported
 * MusicXML files in the shared Firestore library -- i.e. from other (anonymous-auth) clients --
 * so interpolating them raw would let one member's crafted file run script on everyone's device.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
