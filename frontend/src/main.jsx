import React from 'react'
import ReactDOM from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import { GoogleOAuthProvider } from '@react-oauth/google'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId="309372709932-35cueldgo77ssqm2gnit2bnnr40bqeab.apps.googleusercontent.com">
      <App />
    </GoogleOAuthProvider>
    <Analytics />
  </React.StrictMode>,
)
