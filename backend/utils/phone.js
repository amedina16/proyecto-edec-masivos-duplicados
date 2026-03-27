function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith("521") && digits.length === 13) digits = "52" + digits.slice(3);
  if (digits.startsWith("52") && digits.length === 12) return "+" + digits;
  if (digits.length === 10) return "+52" + digits;
  if (digits.length > 10) return "+" + digits;
  return null;
}

module.exports = { normalizePhone };
