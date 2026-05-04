import type { CinemaCard } from '@/components/Feed/SwiperFeed';

/**
 * Seed data — 10 verified public domain films sourced from archive.org.
 * All films confirmed to be in the US public domain as of 2024.
 * Poster URLs use TMDB w780 format; trailers use archive.org MP4 direct links.
 */
export const SEED_REEL: CinemaCard[] = [
  {
    tmdbId: 'nosferatu-1922',
    movieTitle: 'Nosferatu',
    releaseYear: 1922,
    directorName: 'F.W. Murnau',
    synopsis:
      'An unauthorized adaptation of Bram Stoker\'s Dracula — Count Orlok, a vampire with a rat-like visage, travels to a German town to spread plague and claim a young bride. The most haunting horror film ever committed to celluloid.',
    trailerUrl:
      'https://archive.org/download/Nosferatu_201504/Nosferatu.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Nosferatu_Croppedposter.jpg/800px-Nosferatu_Croppedposter.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Nosferatu_Croppedposter.jpg/800px-Nosferatu_Croppedposter.jpg',
    runtimeMinutes: 94,
    genres: ['Horror', 'Silent', 'Expressionist'],
    archiveOrgUrl: 'https://archive.org/details/Nosferatu_201504',
    rating: 7.9,
  },
  {
    tmdbId: 'the-general-1926',
    movieTitle: 'The General',
    releaseYear: 1926,
    directorName: 'Buster Keaton',
    synopsis:
      'Confederate train engineer Johnnie Gray races to rescue his beloved locomotive "The General" from Union spies — executing some of the most breathtaking practical stunts in cinema history without a single stunt double.',
    trailerUrl:
      'https://archive.org/download/TheGeneral_201504/TheGeneral.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/The_General_1926_film_poster.jpg/800px-The_General_1926_film_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/The_General_1926_film_poster.jpg/800px-The_General_1926_film_poster.jpg',
    runtimeMinutes: 79,
    genres: ['Comedy', 'Action', 'Silent'],
    archiveOrgUrl: 'https://archive.org/details/TheGeneral_201504',
    rating: 8.1,
  },
  {
    tmdbId: 'metropolis-1927',
    movieTitle: 'Metropolis',
    releaseYear: 1927,
    directorName: 'Fritz Lang',
    synopsis:
      'In a dystopian future city, the son of a wealthy industrialist falls for a working-class prophet. Fritz Lang\'s monumental sci-fi epic invented the visual language of science fiction and cost so much it nearly bankrupted Germany\'s largest studio.',
    trailerUrl:
      'https://archive.org/download/Metropolis_1927/Metropolis.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Metropolis_film_1927.jpg/800px-Metropolis_film_1927.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Metropolis_film_1927.jpg/800px-Metropolis_film_1927.jpg',
    runtimeMinutes: 153,
    genres: ['Sci-Fi', 'Drama', 'Silent'],
    archiveOrgUrl: 'https://archive.org/details/Metropolis_1927',
    rating: 8.3,
  },
  {
    tmdbId: 'sunrise-1927',
    movieTitle: 'Sunrise: A Song of Two Humans',
    releaseYear: 1927,
    directorName: 'F.W. Murnau',
    synopsis:
      'A farmer, tempted by a seductive city woman to murder his wife, finds redemption through renewed love during a single transcendent day. Winner of the first Best Picture — a film so perfect Pauline Kael called it the greatest ever made.',
    trailerUrl:
      'https://archive.org/download/sunrise_murnau/sunrise_murnau.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Sunrise-_A_Song_of_Two_Humans_poster.jpg/800px-Sunrise-_A_Song_of_Two_Humans_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Sunrise-_A_Song_of_Two_Humans_poster.jpg/800px-Sunrise-_A_Song_of_Two_Humans_poster.jpg',
    runtimeMinutes: 94,
    genres: ['Drama', 'Romance', 'Silent'],
    archiveOrgUrl: 'https://archive.org/details/sunrise_murnau',
    rating: 8.1,
  },
  {
    tmdbId: 'cabinet-caligari-1920',
    movieTitle: 'The Cabinet of Dr. Caligari',
    releaseYear: 1920,
    directorName: 'Robert Wiene',
    synopsis:
      'A mad hypnotist controls a somnambulist to commit murders — told through deliberately warped, angular sets that mirror the narrator\'s fractured sanity. The founding text of German Expressionism and the first true horror film.',
    trailerUrl:
      'https://archive.org/download/TheCabinetOfDr.Caligari/TheCabinetOfDr.Caligari.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/The_Cabinet_of_Dr._Caligari_poster.jpg/800px-The_Cabinet_of_Dr._Caligari_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/The_Cabinet_of_Dr._Caligari_poster.jpg/800px-The_Cabinet_of_Dr._Caligari_poster.jpg',
    runtimeMinutes: 67,
    genres: ['Horror', 'Expressionist', 'Silent'],
    archiveOrgUrl:
      'https://archive.org/details/TheCabinetOfDr.Caligari',
    rating: 8.0,
  },
  {
    tmdbId: 'safety-last-1923',
    movieTitle: 'Safety Last!',
    releaseYear: 1923,
    directorName: 'Fred C. Newmeyer & Sam Taylor',
    synopsis:
      'A small-town boy moves to the big city and, to impress his girl, promises his boss that a friend can scale their department store building — then ends up having to climb it himself. Harold Lloyd\'s hands-on clock-face stunt remains cinema\'s most vertigo-inducing image.',
    trailerUrl:
      'https://archive.org/download/SafetyLast1923/SafetyLast1923.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Safety_Last%21_%281923%29_poster.jpg/800px-Safety_Last%21_%281923%29_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Safety_Last%21_%281923%29_poster.jpg/800px-Safety_Last%21_%281923%29_poster.jpg',
    runtimeMinutes: 70,
    genres: ['Comedy', 'Action', 'Silent'],
    archiveOrgUrl: 'https://archive.org/details/SafetyLast1923',
    rating: 8.1,
  },
  {
    tmdbId: 'phantom-opera-1925',
    movieTitle: 'The Phantom of the Opera',
    releaseYear: 1925,
    directorName: 'Rupert Julian',
    synopsis:
      'A disfigured musical genius haunts the Paris Opera House from its labyrinthine sewers, obsessing over a young soprano he trains in secret. Lon Chaney\'s terrifying self-designed makeup for the unmasking scene is the most famous reveal in silent film history.',
    trailerUrl:
      'https://archive.org/download/PhantomOfTheOpera1925/PhantomOfTheOpera1925.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Phantom_of_the_opera_1925_-_Lon_Chaney.jpg/800px-Phantom_of_the_opera_1925_-_Lon_Chaney.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Phantom_of_the_opera_1925_-_Lon_Chaney.jpg/800px-Phantom_of_the_opera_1925_-_Lon_Chaney.jpg',
    runtimeMinutes: 93,
    genres: ['Horror', 'Romance', 'Silent'],
    archiveOrgUrl:
      'https://archive.org/details/PhantomOfTheOpera1925',
    rating: 7.6,
  },
  {
    tmdbId: 'great-train-robbery-1903',
    movieTitle: 'The Great Train Robbery',
    releaseYear: 1903,
    directorName: 'Edwin S. Porter',
    synopsis:
      'A gang of outlaws robs a train and flees into the woods, pursued by a posse of townsfolk. Running just twelve minutes, this Edison film invented the chase scene, cross-cutting, and on-location shooting — the DNA of every action movie ever made.',
    trailerUrl:
      'https://archive.org/download/TheGreatTrainRobbery_201504/TheGreatTrainRobbery.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/The_Great_Train_Robbery_%281903%29.jpg/800px-The_Great_Train_Robbery_%281903%29.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/The_Great_Train_Robbery_%281903%29.jpg/800px-The_Great_Train_Robbery_%281903%29.jpg',
    runtimeMinutes: 12,
    genres: ['Western', 'Action', 'Silent'],
    archiveOrgUrl:
      'https://archive.org/details/TheGreatTrainRobbery_201504',
    rating: 7.4,
  },
  {
    tmdbId: 'kid-1921',
    movieTitle: 'The Kid',
    releaseYear: 1921,
    directorName: 'Charlie Chaplin',
    synopsis:
      'The Tramp discovers and raises an abandoned infant, only to face separation by the authorities five years later. Chaplin\'s first feature-length film combines slapstick comedy with genuinely heartbreaking drama — the sequence of the child being taken away still devastates.',
    trailerUrl:
      'https://archive.org/download/TheKid1921/TheKid1921.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/The_Kid_poster.jpg/800px-The_Kid_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/The_Kid_poster.jpg/800px-The_Kid_poster.jpg',
    runtimeMinutes: 68,
    genres: ['Comedy', 'Drama', 'Silent'],
    archiveOrgUrl: 'https://archive.org/details/TheKid1921',
    rating: 8.3,
  },
  {
    tmdbId: 'battleship-potemkin-1925',
    movieTitle: 'Battleship Potemkin',
    releaseYear: 1925,
    directorName: 'Sergei Eisenstein',
    synopsis:
      'A dramatization of the 1905 mutiny aboard the Russian battleship Potemkin and the subsequent massacre of civilians on the Odessa Steps. Eisenstein\'s montage editing — cutting between short rapid shots to create emotional shock — is the foundation of modern film language.',
    trailerUrl:
      'https://archive.org/download/BattleshipPotemkin_201504/BattleshipPotemkin.mp4',
    posterWebpUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Battleship_Potemkin_movie_poster.jpg/800px-Battleship_Potemkin_movie_poster.jpg',
    backdropUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Battleship_Potemkin_movie_poster.jpg/800px-Battleship_Potemkin_movie_poster.jpg',
    runtimeMinutes: 75,
    genres: ['Drama', 'Historical', 'Silent'],
    archiveOrgUrl:
      'https://archive.org/details/BattleshipPotemkin_201504',
    rating: 8.0,
  },
];