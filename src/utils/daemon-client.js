/**
 * Shared config for talking to the bypass daemon (bypass/daemon.js).
 * Single source of truth for its URL — used by both the captcha REST routes
 * and the inline WAF detector, so the default and env name don't drift apart.
 */
const DAEMON_URL = process.env.CAPTCHA_DAEMON_URL || 'http://192.168.0.58:9099'

module.exports = { DAEMON_URL }
