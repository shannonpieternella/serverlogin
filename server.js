// Laad vereiste modules
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config(); // Laad .env-bestand

// Initialiseer Stripe met API-sleutel uit .env
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Maak de Express-app
const app = express();

// Middleware
app.use(bodyParser.json());
app.use(cors());

// MongoDB-verbinding
const mongoURI = "mongodb+srv://tradingviewsentinel:QrkpjJvX0PBnX0j2@sentinel.6czw8.mongodb.net/test?retryWrites=true&w=majority&appName=SENTINEL";

mongoose
    .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("Verbonden met MongoDB"))
    .catch((err) => console.error("Fout bij verbinden met MongoDB:", err));

// Mongoose-schema en -model voor gebruikers
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
});

const User = mongoose.model("User", userSchema);

// Controleer actieve abonnementen via e-mailadres
const checkActiveSubscriptionByEmail = async (email) => {
    try {
        // Zoek de klant in Stripe met het opgegeven e-mailadres
        const customers = await stripe.customers.list({ email });
        if (customers.data.length === 0) {
            return false; // Geen klant gevonden
        }

        const customerId = customers.data[0].id;

        // Controleer op actieve abonnementen voor deze klant
        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: "active",
        });

        return subscriptions.data.length > 0; // True als er een actieve abonnement is
    } catch (error) {
        console.error("Fout bij het controleren van abonnementen:", error);
        return false;
    }
};

// API-endpoint: Registreren
app.post("/register", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email en wachtwoord zijn verplicht" });
    }

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: "Gebruiker bestaat al" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = new User({ email, password: hashedPassword });
        await user.save();

        res.status(201).json({ message: "Gebruiker succesvol geregistreerd" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Serverfout" });
    }
});

// API-endpoint: Inloggen
app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(400).json({ error: "Ongeldige inloggegevens" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: "Ongeldige inloggegevens" });
        }

        const hasActiveSubscription = await checkActiveSubscriptionByEmail(email);

        if (hasActiveSubscription) {
            console.log("Gebruiker heeft een actieve subscriptie.");
            return res.status(200).json({
                message: "Ingelogd!",
                hasActiveSubscription: true,
            });
        } else {
            console.log("Gebruiker heeft geen actieve subscriptie.");
            return res.status(200).json({
                message: "Ingelogd, maar geen actieve subscriptie gevonden.",
                hasActiveSubscription: false,
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Serverfout" });
    }
});

// Start de server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server draait op http://localhost:${PORT}`));
