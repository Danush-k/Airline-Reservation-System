const express = require('express');
const router = express.Router();
const { getDB } = require('../config/db');

// GET /api/flights — list all flights with airport info
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const flights = await db.collection('flights').aggregate([
      {
        $lookup: {
          from: 'airports',
          localField: 'origin_ref',
          foreignField: '_id',
          as: 'origin'
        }
      },
      { $unwind: { path: '$origin', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'airports',
          localField: 'destination_ref',
          foreignField: '_id',
          as: 'destination'
        }
      },
      { $unwind: { path: '$destination', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'aircraft',
          localField: 'aircraft_ref',
          foreignField: '_id',
          as: 'aircraft'
        }
      },
      { $unwind: { path: '$aircraft', preserveNullAndEmptyArrays: true } }
    ]).toArray();

    res.json({ success: true, data: flights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/flights/search?origin=MAA&destination=DEL&date=2025-04-01
router.get('/search', async (req, res) => {
  try {
    const db = getDB();
    const { origin, destination, date } = req.query;

    const query = { status: { $in: ['scheduled', 'delayed'] } };
    if (origin) query.origin_ref = origin;
    if (destination) query.destination_ref = destination;
    if (date) {
      const dayStart = new Date(date + 'T00:00:00Z');
      const dayEnd = new Date(date + 'T23:59:59Z');
      query.departure_time = { $gte: dayStart, $lte: dayEnd };
    }

    const flights = await db.collection('flights').aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'airports',
          localField: 'origin_ref',
          foreignField: '_id',
          as: 'origin'
        }
      },
      { $unwind: { path: '$origin', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'airports',
          localField: 'destination_ref',
          foreignField: '_id',
          as: 'destination'
        }
      },
      { $unwind: { path: '$destination', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'aircraft',
          localField: 'aircraft_ref',
          foreignField: '_id',
          as: 'aircraft'
        }
      },
      { $unwind: { path: '$aircraft', preserveNullAndEmptyArrays: true } }
    ]).toArray();

    res.json({ success: true, data: flights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/flights/:id
router.get('/:id', async (req, res) => {
  try {
    const db = getDB();
    const flight = await db.collection('flights').findOne({ _id: req.params.id });
    if (!flight) return res.status(404).json({ success: false, error: 'Flight not found' });
    res.json({ success: true, data: flight });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/flights/:id/seats?cabin_class=economy
router.get('/:id/seats', async (req, res) => {
  try {
    const db = getDB();
    const { cabin_class, session_id } = req.query;
    if (!cabin_class) return res.status(400).json({ success: false, error: 'cabin_class required' });

    const flight = await db.collection('flights').findOne({ _id: req.params.id });
    if (!flight) return res.status(404).json({ success: false, error: 'Flight not found' });

    const inventory = flight.seat_inventory[cabin_class];
    if (!inventory) return res.status(400).json({ success: false, error: 'Invalid cabin class' });

    // Clean up expired holds
    await db.collection('seat_holds').deleteMany({
      expires_at: { $lt: new Date() }
    });

    // Get all booked seats for this flight + cabin class (only confirmed bookings)
    const bookedBookings = await db.collection('bookings').find({
      flight_ref: req.params.id,
      cabin_class: cabin_class,
      booking_status: 'confirmed'
    }, { projection: { seat_number: 1 } }).toArray();

    const bookedSeats = new Set(bookedBookings.map(b => b.seat_number));

    // Get active holds
    const activeHolds = await db.collection('seat_holds').find({
      flight_ref: req.params.id,
      cabin_class: cabin_class
    }).toArray();
    
    const heldSeatsMap = new Map();
    activeHolds.forEach(h => heldSeatsMap.set(h.seat_number, h.session_id));

    // Generate seat layout
    const totalSeats = inventory.total;
    const cols = cabin_class === 'business' ? 4 : 6; // Business: A-D (4 cols), Economy: A-F (6 cols)
    const rows = Math.ceil(totalSeats / cols);
    const colLabels = cabin_class === 'business'
      ? ['A', 'B', 'C', 'D']
      : ['A', 'B', 'C', 'D', 'E', 'F'];

    // Aisle positions (for visual spacing)
    const aisleAfter = cabin_class === 'business' ? [1] : [2]; // after B or after C

    const seats = [];
    let count = 0;
    for (let r = 1; r <= rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (count >= totalSeats) break;
        const seatId = `${r}${colLabels[c]}`;
        
        let status = 'available';
        if (bookedSeats.has(seatId)) {
          status = 'booked';
        } else if (heldSeatsMap.has(seatId) && heldSeatsMap.get(seatId) !== session_id) {
          status = 'held';
        }
        
        seats.push({
          id: seatId,
          row: r,
          col: colLabels[c],
          status: status,
          isAisle: aisleAfter.includes(c)
        });
        count++;
      }
    }

    res.json({
      success: true,
      data: {
        flight_id: req.params.id,
        cabin_class,
        total: totalSeats,
        available: inventory.available,
        booked: bookedSeats.size,
        columns: colLabels,
        aisle_after: aisleAfter,
        seats
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
