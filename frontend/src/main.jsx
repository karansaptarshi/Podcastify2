import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.jsx'
import BookDetails from './pages/BookDetails.jsx'
import AudioPlayer from './pages/AudioPlayer.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/book" element={<BookDetails />} />
        <Route path="/player" element={<AudioPlayer />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
