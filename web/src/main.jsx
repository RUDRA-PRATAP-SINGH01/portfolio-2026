import './world/threeConsole.js'           // (first: before any canvas is made)
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(<App />)
