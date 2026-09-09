// Flight Info Component - Detailed flight information panel

import React from "react";
import { Box, Text } from "ink";
import {
  type Flight,
  CYBER_COLORS,
  formatDuration,
  formatTime,
  formatTimezoneAbbreviation,
  formatPrice,
} from "../types";

interface Props {
  flight: Flight;
}

export function FlightInfo({ flight }: Props) {
  const cabinLabels: Record<string, string> = {
    economy: "Economy",
    premium: "Premium Economy",
    business: "Business",
    first: "First Class",
  };

  return (
    <Box flexDirection="column">
      {/* Row 1: Departure / Arrival */}
      <Box>
        <Box width={20}>
          <Text color={CYBER_COLORS.dim}>DEPARTURE</Text>
        </Box>
        <Box width={20}>
          <Text color={CYBER_COLORS.dim}>ARRIVAL</Text>
        </Box>
        <Box>
          <Text color={CYBER_COLORS.dim}>DURATION</Text>
        </Box>
      </Box>

      <Box marginBottom={1}>
        <Box width={20}>
          <Text color={CYBER_COLORS.neonCyan} bold>
            {formatTime(flight.departureTime, flight.origin.timezone)}{" "}
            {formatTimezoneAbbreviation(flight.origin.timezone, flight.departureTime)}
          </Text>
        </Box>
        <Box width={20}>
          <Text color={CYBER_COLORS.neonCyan} bold>
            {formatTime(flight.arrivalTime, flight.destination.timezone)}{" "}
            {formatTimezoneAbbreviation(flight.destination.timezone, flight.arrivalTime)}
          </Text>
        </Box>
        <Box>
          <Text color={CYBER_COLORS.neonCyan} bold>
            {formatDuration(flight.duration)}
          </Text>
        </Box>
      </Box>

      {/* Row 2: Aircraft / Class / Price */}
      <Box>
        <Box width={20}>
          <Text color={CYBER_COLORS.dim}>AIRCRAFT</Text>
        </Box>
        <Box width={20}>
          <Text color={CYBER_COLORS.dim}>CLASS</Text>
        </Box>
        <Box>
          <Text color={CYBER_COLORS.dim}>PRICE</Text>
        </Box>
      </Box>

      <Box>
        <Box width={20}>
          <Text color="white">{flight.aircraft || "---"}</Text>
        </Box>
        <Box width={20}>
          <Text color="white">{cabinLabels[flight.cabinClass]}</Text>
        </Box>
        <Box>
          <Text color={CYBER_COLORS.neonGreen} bold>
            {formatPrice(flight.price, flight.currency)}
          </Text>
        </Box>
      </Box>

      {/* Row 3: Airline / Flight Number */}
      <Box marginTop={1}>
        <Text color={CYBER_COLORS.dim}>
          {flight.airline} {flight.flightNumber}
          {flight.stops > 0 && ` (${flight.stops} stop${flight.stops > 1 ? "s" : ""})`}
        </Text>
      </Box>
    </Box>
  );
}
