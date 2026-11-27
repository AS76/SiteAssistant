ALTER TABLE users ADD COLUMN language TEXT CHECK (language IN ('it', 'en') OR language IS NULL);
ALTER TABLE users ADD COLUMN shared_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE signup_requests ADD COLUMN language TEXT CHECK (language IN ('it', 'en') OR language IS NULL);
