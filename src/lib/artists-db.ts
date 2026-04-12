export type DBArtist = {
    name: string
    lang: 'en' | 'pt' | 'es' | 'ko' | 'ja' | 'ru' | 'fr' | 'other'
    genre: 'pop' | 'hip-hop' | 'rock' | 'rb' | 'latin' | 'k-pop' | 'j-pop' | 'electronic' | 'vintage'
    spotify_artist_id?: string
}

export const ARTISTS_DB: DBArtist[] = [
    // --- English Pop ---
    { name: 'Taylor Swift', lang: 'en', genre: 'pop', spotify_artist_id: '06HL4z0CvFAxy0ZP6p3uUe' },
    { name: 'Ariana Grande', lang: 'en', genre: 'pop', spotify_artist_id: '66CXWjJsnmPANWIB0q1Nqb' },
    { name: 'Ed Sheeran', lang: 'en', genre: 'pop', spotify_artist_id: '6eUukEEsqTpRrtkMKq8BvE' },
    { name: 'Justin Bieber', lang: 'en', genre: 'pop', spotify_artist_id: '1uNFoZAHBGtllmpy0G0Y0I' },
    { name: 'Dua Lipa', lang: 'en', genre: 'pop', spotify_artist_id: '6M2wZ9GZIrURuIAsuY2NoA' },
    { name: 'Harry Styles', lang: 'en', genre: 'pop', spotify_artist_id: '6KImCVD70vtGezmFWvU8iY' },
    { name: 'Olivia Rodrigo', lang: 'en', genre: 'pop', spotify_artist_id: '1McMsnEElThX1crpJDpMfs' },
    { name: 'Billie Eilish', lang: 'en', genre: 'pop', spotify_artist_id: '6qqNVTkY8uBg9cP3J7sYbb' },
    { name: 'Katy Perry', lang: 'en', genre: 'pop', spotify_artist_id: '6jJ0s89eD6GaHhpKj2uVK3' },
    { name: 'Miley Cyrus', lang: 'en', genre: 'pop', spotify_artist_id: '5YGYtDeuWeu0nUzlLsS8DX' },

    // --- English Hip-Hop/Rap ---
    { name: 'Drake', lang: 'en', genre: 'hip-hop', spotify_artist_id: '3TVXtAsR1Inumwj47NSAMP' },
    { name: 'Kanye West', lang: 'en', genre: 'hip-hop', spotify_artist_id: '5K4W6rqBFWDn96Pg9OqC02' },
    { name: 'Kendrick Lamar', lang: 'en', genre: 'hip-hop', spotify_artist_id: '2YZyLoL8N0uoCmBVNqP0Gv' },
    { name: 'Travis Scott', lang: 'en', genre: 'hip-hop', spotify_artist_id: '0Y5tJX1qyxzuOD7aFgnMzh' },
    { name: 'Eminem', lang: 'en', genre: 'hip-hop', spotify_artist_id: '7dGjo223GvS2XzXdvJRs2n' },
    { name: 'Post Malone', lang: 'en', genre: 'hip-hop', spotify_artist_id: '246YpSfa6Xv9ThqEMU6tD6' },
    { name: 'Future', lang: 'en', genre: 'hip-hop', spotify_artist_id: '1RyvyyTE3xzB2IwsasT74y' },
    { name: 'Jack Harlow', lang: 'en', genre: 'hip-hop', spotify_artist_id: '2LIoW2S2eC4I1vU6q0ht9F' },
    { name: '21 Savage', lang: 'en', genre: 'hip-hop', spotify_artist_id: '1URnDIvWoZwm0XUvqiVNVv' },

    // --- English Rock/Alt ---
    { name: 'Metallica', lang: 'en', genre: 'rock', spotify_artist_id: '2ye2Wgw4gLf7oPRFq2B6vM' },
    { name: 'Linkin Park', lang: 'en', genre: 'rock', spotify_artist_id: '6XyY88ogvSfsI6CcRrNqMT' },
    { name: 'Arctic Monkeys', lang: 'en', genre: 'rock', spotify_artist_id: '7Ln80S36vabn0Yvqs40y9S' },
    { name: 'Nirvana', lang: 'en', genre: 'rock', spotify_artist_id: '6olE6TJLq0og3zqNzyfsCQ' },
    { name: 'Radiohead', lang: 'en', genre: 'rock', spotify_artist_id: '4Z8W48P392vU3asKJp9pU6' },
    { name: 'The Killers', lang: 'en', genre: 'rock', spotify_artist_id: '0C0Xl3uD3vNRthZzb7SvcB' },
    { name: 'Green Day', lang: 'en', genre: 'rock', spotify_artist_id: '7oPftvl6afIv5gnp9sST60' },
    { name: 'Foo Fighters', lang: 'en', genre: 'rock', spotify_artist_id: '7jy3rLJdDQY21UvRAgsMWT' },

    // --- Portuguese (Brazil/Portugal) ---
    { name: 'Anitta', lang: 'pt', genre: 'pop', spotify_artist_id: '767goV8nkZiy3mZ6TbtppH' },
    { name: 'Luísa Sonza', lang: 'pt', genre: 'pop', spotify_artist_id: '4P6S7S9mO5f4Tf7P29IuX8' },
    { name: 'Ludmilla', lang: 'pt', genre: 'pop', spotify_artist_id: '3A6S7S9mO5f4Tf7P29IuX8' }, 
    { name: 'Luan Santana', lang: 'pt', genre: 'pop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Pabllo Vittar', lang: 'pt', genre: 'pop', spotify_artist_id: '3A6S7S9mO5f4Tf7P29IuX8' },
    { name: 'Ana Castela', lang: 'pt', genre: 'pop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Jorge & Mateus', lang: 'pt', genre: 'pop', spotify_artist_id: '1mSdb7v6Xv9ThqEMU6tD6' },
    { name: 'MC Ryan SP', lang: 'pt', genre: 'hip-hop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Matuê', lang: 'pt', genre: 'hip-hop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Filipe Ret', lang: 'pt', genre: 'hip-hop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Salvador Sobral', lang: 'pt', genre: 'pop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'Bárbara Bandeira', lang: 'pt', genre: 'pop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },
    { name: 'T-Rex', lang: 'pt', genre: 'hip-hop', spotify_artist_id: '3q7v6Xv9ThqEMU6tD6' },

    // --- Spanish (Latin/Spain) ---
    { name: 'Bad Bunny', lang: 'es', genre: 'latin', spotify_artist_id: '4q3InR89uUr7gIkpSclGbh' },
    { name: 'Karol G', lang: 'es', genre: 'latin', spotify_artist_id: '7gRupSclGbh4q3InR89uUr' },
    { name: 'J Balvin', lang: 'es', genre: 'latin', spotify_artist_id: '1vyhD5VmyZ7KMpWz9q9Ki2' },
    { name: 'Rosalía', lang: 'es', genre: 'pop', spotify_artist_id: '7ltDVBr6mKb0u69tXNdf6A' },
    { name: 'Rauw Alejandro', lang: 'es', genre: 'latin', spotify_artist_id: '7iK8pXO48V6tI3CDvLaasC' },
    { name: 'Feid', lang: 'es', genre: 'latin', spotify_artist_id: '2LRo4vC0S6P9T5Z7vLRo4v' },
    { name: 'Maluma', lang: 'es', genre: 'latin', spotify_artist_id: '1r4vC0S6P9T5Z7vLRo4vKi' },
    { name: 'Daddy Yankee', lang: 'es', genre: 'latin', spotify_artist_id: '4E5S7S9mO5f4Tf7P29IuX8' },
    { name: 'Peso Pluma', lang: 'es', genre: 'latin', spotify_artist_id: '1mSdb7v6Xv9ThqEMU6tD6' },
    { name: 'Shakira', lang: 'es', genre: 'pop', spotify_artist_id: '0EzhvBvXubm7at7ZULKChL' },
    { name: 'Quevedo', lang: 'es', genre: 'latin', spotify_artist_id: '5Y6S7S9mO5f4Tf7P29IuX8' },

    // --- Korean (K-Pop) ---
    { name: 'BTS', lang: 'ko', genre: 'k-pop', spotify_artist_id: '3Nrf2Ee0v9PbdZ6db32o7u' },
    { name: 'Blackpink', lang: 'ko', genre: 'k-pop', spotify_artist_id: '41MozWvKHGa7Exj9C9htUf' },
    { name: 'NewJeans', lang: 'ko', genre: 'k-pop', spotify_artist_id: '6vWSSv6C9Ga7Exj9C9htUf' },
    { name: 'Twice', lang: 'ko', genre: 'k-pop', spotify_artist_id: '7n2YpSfa6Xv9ThqEMU6tD6' },
    { name: 'Stray Kids', lang: 'ko', genre: 'k-pop', spotify_artist_id: '2D0S7S9mO5f4Tf7P29IuX8' },
    { name: 'IVE', lang: 'ko', genre: 'k-pop', spotify_artist_id: '1EzhvBvXubm7at7ZULKChL' },
    { name: 'Fifty Fifty', lang: 'ko', genre: 'k-pop', spotify_artist_id: '5A6S7S9mO5f4Tf7P29IuX8' },

    // --- Japanese (J-Pop/AniSong) ---
    { name: 'YOASOBI', lang: 'ja', genre: 'j-pop', spotify_artist_id: '6vWSSv6C9Ga7Exj9C9htUf' },
    { name: 'Fujii Kaze', lang: 'ja', genre: 'j-pop', spotify_artist_id: '3A6S7S9mO5f4Tf7P29IuX8' },
    { name: 'LiSA', lang: 'ja', genre: 'j-pop', spotify_artist_id: '1A6S7S9mO5f4Tf7P29IuX8' },
    { name: 'Official HIGE DANdism', lang: 'ja', genre: 'j-pop', spotify_artist_id: '2A6S7S9mO5f4Tf7P29IuX8' },
    { name: 'Kenshi Yonezu', lang: 'ja', genre: 'j-pop', spotify_artist_id: '1EzhvBvXubm7at7ZULKChL' },

    // --- Vintage/Classic ---
    { name: 'Michael Jackson', lang: 'en', genre: 'vintage', spotify_artist_id: '3fMbdpBgbZzw6Zubc989vB' },
    { name: 'Queen', lang: 'en', genre: 'vintage', spotify_artist_id: '1dfeR4HaWDbWqFBsECL1MW' },
    { name: 'The Beatles', lang: 'en', genre: 'vintage', spotify_artist_id: '3WrFJ7ztpcyG5f0br0-I9R' },
    { name: 'ABBA', lang: 'en', genre: 'vintage', spotify_artist_id: '0X98pVrG7J8h0JqH6jYlK' },
    { name: 'Whitney Houston', lang: 'en', genre: 'vintage', spotify_artist_id: '6XpaFmU9vO6V8y0A0Z9fO' },
    { name: 'Elvis Presley', lang: 'en', genre: 'vintage', spotify_artist_id: '43Zeb9pW7f0br0-I9R' },

    // --- French ---
    { name: 'Stromae', lang: 'fr', genre: 'pop', spotify_artist_id: '7tYmSAbvU7Adp2zofq6902' },
    { name: 'Angèle', lang: 'fr', genre: 'pop', spotify_artist_id: '16r9rSpxonvXm7pG6pp20H' },
    { name: 'Indila', lang: 'fr', genre: 'pop', spotify_artist_id: '3A6S7S9mO5f4Tf7P29IuX8' },
    { name: 'Daft Punk', lang: 'en', genre: 'electronic', spotify_artist_id: '4tZwfgrHOu2pIliunYv97C' },
    { name: 'David Guetta', lang: 'en', genre: 'pop', spotify_artist_id: '1Cs0zR_6Xv9ThqEMU6tD6' },
]
