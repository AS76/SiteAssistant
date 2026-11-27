ALTER TABLE users ADD COLUMN language TEXT CHECK (language IN ('it', 'en') OR language IS NULL);
ALTER TABLE users ADD COLUMN shared_demo BOOLEAN NOT NULL DEFAULT 0 CHECK (shared_demo IN (0, 1));
ALTER TABLE signup_requests ADD COLUMN language TEXT CHECK (language IN ('it', 'en') OR language IS NULL);
