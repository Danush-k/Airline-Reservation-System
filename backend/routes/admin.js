const express = require('express');
const router = express.Router();
const { getDB } = require('../config/db');
const { Int32, Double } = require('mongodb');

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const db = getDB();

    // Total counts
    const [totalFlights, totalPassengers, totalBookings, totalTickets] = await Promise.all([
      db.collection('flights').countDocuments(),
      db.collection('passengers').countDocuments(),
      db.collection('bookings').countDocuments(),
      db.collection('tickets').countDocuments()
    ]);

    // Booking stats by status
    const bookingStats = await db.collection('bookings').aggregate([
      {
        $group: {
          _id: '$booking_status',
          count: { $sum: 1 },
          total_revenue: { $sum: '$fare_paid' }
        }
      }
    ]).toArray();

    // Revenue by cabin class
    const revenueByCabin = await db.collection('bookings').aggregate([
      { $match: { booking_status: 'confirmed' } },
      {
        $group: {
          _id: '$cabin_class',
          count: { $sum: 1 },
          revenue: { $sum: '$fare_paid' }
        }
      }
    ]).toArray();

    // Flight occupancy
    const flightOccupancy = await db.collection('flights').aggregate([
      {
        $project: {
          flight_number: 1,
          origin_ref: 1,
          destination_ref: 1,
          status: 1,
          economy_occupancy: {
            $cond: {
              if: { $gt: ['$seat_inventory.economy.total', 0] },
              then: {
                $multiply: [
                  { $divide: [
                    { $subtract: ['$seat_inventory.economy.total', '$seat_inventory.economy.available'] },
                    '$seat_inventory.economy.total'
                  ]},
                  100
                ]
              },
              else: 0
            }
          },
          business_occupancy: {
            $cond: {
              if: { $gt: ['$seat_inventory.business.total', 0] },
              then: {
                $multiply: [
                  { $divide: [
                    { $subtract: ['$seat_inventory.business.total', '$seat_inventory.business.available'] },
                    '$seat_inventory.business.total'
                  ]},
                  100
                ]
              },
              else: 0
            }
          },
          seats: '$seat_inventory'
        }
      }
    ]).toArray();

    // Cancellation stats
    const cancellationStats = await db.collection('bookings').aggregate([
      { $match: { booking_status: 'cancelled' } },
      {
        $group: {
          _id: null,
          total_cancellations: { $sum: 1 },
          total_refunds: { $sum: '$cancellation.refund_amount' }
        }
      }
    ]).toArray();

    // Total confirmed revenue
    const confirmedRevenue = bookingStats.find(s => s._id === 'confirmed');

    res.json({
      success: true,
      data: {
        overview: {
          total_flights: totalFlights,
          total_passengers: totalPassengers,
          total_bookings: totalBookings,
          total_tickets: totalTickets,
          total_revenue: confirmedRevenue ? Math.round(confirmedRevenue.total_revenue * 100) / 100 : 0,
          confirmed_bookings: confirmedRevenue ? confirmedRevenue.count : 0
        },
        booking_by_status: bookingStats,
        revenue_by_cabin: revenueByCabin,
        flight_occupancy: flightOccupancy,
        cancellations: cancellationStats[0] || { total_cancellations: 0, total_refunds: 0 }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/airports
router.get('/airports', async (req, res) => {
  try {
    const db = getDB();
    const airports = await db.collection('airports').find({}).toArray();
    res.json({ success: true, data: airports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/airports
router.post('/airports', async (req, res) => {
  try {
    const db = getDB();
    if (req.body.coordinates) {
      req.body.coordinates.lat = new Double(req.body.coordinates.lat || 0);
      req.body.coordinates.lng = new Double(req.body.coordinates.lng || 0);
    }
    const result = await db.collection('airports').insertOne(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/aircraft
router.get('/aircraft', async (req, res) => {
  try {
    const db = getDB();
    const aircraft = await db.collection('aircraft').find({}).toArray();
    res.json({ success: true, data: aircraft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/aircraft
router.post('/aircraft', async (req, res) => {
  try {
    const db = getDB();
    
    const reqTotal = parseInt(req.body.total_seats) || 0;
    let reqEcon = 0, reqBiz = 0, reqFirst = 0;
    if (req.body.seat_config) {
        reqEcon = parseInt(req.body.seat_config.economy) || 0;
        reqBiz = parseInt(req.body.seat_config.business) || 0;
        reqFirst = parseInt(req.body.seat_config.first_class) || 0;
    }

    if (reqTotal !== reqEcon + reqBiz + reqFirst) {
        return res.status(400).json({ success: false, error: 'Total seats must exactly match the sum of your economy, business, and first class inputs.' });
    }

    req.body.total_seats = new Int32(reqTotal);
    if (req.body.seat_config) {
      req.body.seat_config.economy = new Int32(reqEcon);
      req.body.seat_config.business = new Int32(reqBiz);
      req.body.seat_config.first_class = new Int32(reqFirst);
    }
    const result = await db.collection('aircraft').insertOne(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/flights
router.get('/flights', async (req, res) => {
  try {
    const db = getDB();
    const flights = await db.collection('flights').find({}).sort({departure_time: 1}).limit(20).toArray();
    res.json({ success: true, data: flights });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/flights
router.post('/flights', async (req, res) => {
  try {
    const db = getDB();

    // Validate Existence of Refs
    const { aircraft_ref, origin_ref, destination_ref } = req.body;
    
    const [aircraft, origin, destination] = await Promise.all([
      db.collection('aircraft').findOne({ _id: aircraft_ref }),
      db.collection('airports').findOne({ _id: origin_ref }),
      db.collection('airports').findOne({ _id: destination_ref })
    ]);

    if (!aircraft) return res.status(400).json({ success: false, error: `Aircraft ${aircraft_ref} does not exist.` });
    if (!origin) return res.status(400).json({ success: false, error: `Origin airport ${origin_ref} does not exist.` });
    if (!destination) return res.status(400).json({ success: false, error: `Destination airport ${destination_ref} does not exist.` });

    // Use total seats from aircraft for flight inventory
    const totalEco = aircraft.seat_config.economy;
    const totalBiz = aircraft.seat_config.business;
    const totalFirst = aircraft.seat_config.first_class;

    // Ensure dates are parsed
    if (req.body.departure_time) req.body.departure_time = new Date(req.body.departure_time);
    if (req.body.arrival_time) req.body.arrival_time = new Date(req.body.arrival_time);
    
    // Auto-calculate seat inventory if not provided
    if (!req.body.seat_inventory) {
      req.body.seat_inventory = {
        economy: { total: new Int32(totalEco), available: new Int32(totalEco) },
        business: { total: new Int32(totalBiz), available: new Int32(totalBiz) },
        first_class: { total: new Int32(totalFirst), available: new Int32(totalFirst) }
      };
    } else {
        // Cast strict integers
        ['economy', 'business', 'first_class'].forEach(cls => {
          if (req.body.seat_inventory[cls]) {
            req.body.seat_inventory[cls].total = new Int32(req.body.seat_inventory[cls].total || 0);
            req.body.seat_inventory[cls].available = new Int32(req.body.seat_inventory[cls].available || 0);
          }
        });
    }
    
    // Cast strict doubles
    if (req.body.base_fare) {
      req.body.base_fare.economy = new Double(req.body.base_fare.economy || 0);
      req.body.base_fare.business = new Double(req.body.base_fare.business || 0);
      if (req.body.base_fare.first_class !== undefined && req.body.base_fare.first_class !== null) {
        req.body.base_fare.first_class = new Double(req.body.base_fare.first_class);
      } else {
        req.body.base_fare.first_class = null; 
      }
    }

    // Cast pricing_multiplier brackets to proper types
    if (req.body.pricing_multiplier && Array.isArray(req.body.pricing_multiplier)) {
      req.body.pricing_multiplier = req.body.pricing_multiplier.map(b => ({
        occupancy_pct_min: parseInt(b.occupancy_pct_min),
        occupancy_pct_max: parseInt(b.occupancy_pct_max),
        multiplier: new Double(parseFloat(b.multiplier))
      }));
    }

    const result = await db.collection('flights').insertOne(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/pricing-rules
router.get('/pricing-rules', async (req, res) => {
  try {
    const db = getDB();
    const rules = await db.collection('pricing_rules').find({}).toArray();
    res.json({ success: true, data: rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/pricing-rules
router.post('/pricing-rules', async (req, res) => {
  try {
    const db = getDB();
    // Ensure dates are parsed
    if (req.body.valid_from) req.body.valid_from = new Date(req.body.valid_from);
    if (req.body.valid_until) req.body.valid_until = new Date(req.body.valid_until);
    const result = await db.collection('pricing_rules').insertOne(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
