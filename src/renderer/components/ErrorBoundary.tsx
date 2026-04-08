import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    window.electronAPI?.logError?.(
      'ErrorBoundary',
      error.message,
      [error.stack, errorInfo.componentStack].filter(Boolean).join('\n'),
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '24px',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          fontFamily: 'Inter, -apple-system, sans-serif',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>
            Something went wrong
          </div>
          <div style={{
            fontSize: '13px',
            color: '#888',
            marginBottom: '20px',
            maxWidth: '400px',
            textAlign: 'center',
            wordBreak: 'break-word',
          }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              backgroundColor: '#5a7aff',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
