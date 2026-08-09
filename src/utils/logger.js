// Structured console logging. `data` is logged as a JSON blob so fields
// like position-sizing inputs (account balance, stop distance, computed
// qty/risk) are always fully captured, not summarized away (brief bug #2).
function line(level, scope, message, data) {
  const entry = { ts: new Date().toISOString(), level, scope, message };
  if (data !== undefined) entry.data = data;
  console.log(JSON.stringify(entry));
}

module.exports = {
  info: (scope, message, data) => line('info', scope, message, data),
  warn: (scope, message, data) => line('warn', scope, message, data),
  error: (scope, message, data) => line('error', scope, message, data),
};
