/** Menu / nav icon — D4AI robot avatar */
export function D4AiNavIcon({ className }: { className?: string }) {
  return (
    <img
      src="/d4ai-avatar.png"
      alt="D4AI"
      className={className}
      style={{ borderRadius: "9999px", objectFit: "cover" }}
    />
  );
}
