import { useState } from 'react'
import { AlertCircle, Loader2, Monitor, Moon, Sun, UserCheck } from 'lucide-react'
import hubLogo from '../assets/icon_wh_small.png'
import type { ThemeMode } from '../main/types'
import { getFirebaseConfigError, loginAnonymously } from './firebase'

interface WelcomeScreenProps {
  currentTheme: ThemeMode
  onThemeChange: (theme: ThemeMode) => void
}

export function WelcomeScreen({ currentTheme, onThemeChange }: WelcomeScreenProps) {
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const configError = getFirebaseConfigError()

  const handleAnonymousSignIn = async () => {
    if (loading) return
    setErrorMessage(null)
    setLoading(true)

    try {
      if (configError) {
        throw new Error(configError)
      }
      await loginAnonymously()
      // Note: On successful authentication, onAuthStateChanged in App.tsx
      // receives the authenticated User and opens the application automatically.
    } catch (err: unknown) {
      console.error('[AUTH][WELCOME] Anonymous sign-in error:', err)
      const errObj = err as { code?: string; message?: string }
      const code = errObj.code || ''
      const msg = errObj.message || ''

      if (
        code === 'auth/operation-not-allowed' ||
        code === 'auth/admin-restricted-operation' ||
        msg.includes('ADMIN_ONLY_OPERATION') ||
        msg.includes('operation-not-allowed')
      ) {
        setErrorMessage(
          'Anonymous sign-in is currently disabled in your Firebase Console. To enable it, navigate to: Firebase Console → Authentication → Sign-in method → Anonymous → Enable.'
        )
      } else if (code === 'auth/network-request-failed' || msg.includes('network')) {
        setErrorMessage('Network connection error. Please check your internet connection and try again.')
      } else {
        setErrorMessage(msg || 'Failed to sign in anonymously. Please try again.')
      }
      setLoading(false)
    }
  }

  return (
    <div className="welcome-container" role="main" aria-label="Social HUB Welcome and Authentication">
      {/* Top Bar with Theme Switcher */}
      <div className="welcome-top-bar">
        <div className="theme-toggle-group welcome-theme-toggle">
          <button
            type="button"
            className={`theme-btn ${currentTheme === 'system' ? 'selected' : ''}`}
            onClick={() => onThemeChange('system')}
            title="System theme"
            aria-label="System theme"
          >
            <Monitor size={12} />
          </button>
          <button
            type="button"
            className={`theme-btn ${currentTheme === 'light' ? 'selected' : ''}`}
            onClick={() => onThemeChange('light')}
            title="Light theme"
            aria-label="Light theme"
          >
            <Sun size={12} />
          </button>
          <button
            type="button"
            className={`theme-btn ${currentTheme === 'dark' ? 'selected' : ''}`}
            onClick={() => onThemeChange('dark')}
            title="Dark theme"
            aria-label="Dark theme"
          >
            <Moon size={12} />
          </button>
        </div>
      </div>

      {/* Main Welcome Card */}
      <div className="welcome-card">
        <div className="welcome-brand">
          <img className="welcome-logo" src={hubLogo} alt="Social HUB Logo" />
          <h1 className="welcome-title">Social HUB</h1>
          <p className="welcome-subtitle">
            Your unified desktop workspace for social, messaging, and work accounts.
            All your services together with complete session isolation.
          </p>
        </div>

        {errorMessage && (
          <div className="welcome-error-banner" role="alert">
            <AlertCircle size={16} className="welcome-error-icon" />
            <div className="welcome-error-text">
              <span>{errorMessage}</span>
            </div>
          </div>
        )}

        <div className="welcome-actions">
          {/* Continue Anonymously (Active) */}
          <button
            type="button"
            className="welcome-btn primary-btn"
            onClick={() => void handleAnonymousSignIn()}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Signing in anonymously...</span>
              </>
            ) : (
              <>
                <UserCheck size={16} />
                <span>Continue anonymously</span>
              </>
            )}
          </button>

          {/* Continue with Google (Disabled - Coming Soon) */}
          <button
            type="button"
            className="welcome-btn google-btn disabled"
            disabled
            title="Google Sign-In is coming soon"
            aria-label="Continue with Google (Coming Soon)"
          >
            <svg className="google-icon" viewBox="0 0 24 24" width="16" height="16">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Continue with Google</span>
            <span className="coming-soon-pill">Coming Soon</span>
          </button>
        </div>

        <div className="welcome-footer-info">
          <span>Sessions, accounts, and notifications remain safely stored on this computer.</span>
        </div>
      </div>
    </div>
  )
}
