// ==UserScript==
// @name FMC Extension for GEFS-Online
// @description This extension (by Ethan Shields) adds an FMC which controls other features included such as auto-climb, auto-descent, progress information, etc.
// @namespace GEFS-Plugins
// @match http://www.gefs-online.com/gefs.php*
// @match http://gefs-online.com/gefs.php*
// @run-at document-end
// @version 0.4.7.1505
// @grant none
// ==/UserScript==

// IMPORTANT: Please disable your original autopilot plugin or delete line:14
// AP++ v0.8.1 with AIRAC 1505 (waypoints + navaids), for testing purposes
$('<script type="text/javascript" src="https://dl.dropboxusercontent.com/s/ogrfm3necctimjh/ap_1505.user.js"></script>').appendTo('body');

var tod;
var VNAV = false;
var arrival = [];
var cruise;
var phase = "climb";
var todCalc = false;
var fieldElev = 0;

// Global variables/constants
window.feetToNM = 1 / 6076;
window.nmToFeet = 6076;

// fmc library, publicly accessible methods and variables
window.fmc = {

	math: {
		/**
		 * Turns degrees to radians
		 * 
		 * @param {Number} degrees The degree to be converted
		 * @return {Number} Radians of the degree
		 */
		toRadians: function (d) {
			return d * Math.PI / 180;
		},
		/**
		 * Converts radians to degrees
		 * 
		 * @param {Number} radians The radian to be converted
		 * @return {Number} Degree of the radian
		 */
		toDegrees: function (r) {
			return r * 180 / Math.PI;
		},
		earthRadiusNM: 3440.06
	},
	waypoints: {
		input: "",
		route: [],
		nextWaypoint: "",
		/**
		 * Turns the waypoints into an array
		 *
		 * @return {Array} The array of waypoint names
		 */
		makeFixesArray: function () {
			var result = [];
			var departureVal = $('#departureInput').val();
			if (departureVal) result.push(departureVal);
			$('.waypoint td:first-child div > input').each(function() {
				result.push($(this).val());
			});
			var arrivalVal = $('#arrivalInput').val();
			if (arrivalVal) result.push(arrivalVal);
			
			return result;
		},
		/**
		 * Joins the fixes array into a string
		 *
		 * @return {String} All waypoints, each seperated by a space
		 */
		toFixesString: function () {
			return fmc.waypoints.makeFixesArray().join(" ");
		}, 
		/**
		 * Makes a sharable route
		 * 
		 * @return {String} A sharable route with airports and waypoints, 
		 * 					using <code>JSON.stringify</code> method
		 */
		toRouteString: function () {
			return JSON.stringify ([
				$('#departureInput').val(), 
				$('#arrivalInput').val(), 
				$('#flightNumInput').val(), 
				fmc.waypoints.route
			]);
		}
	}
};

/**
 * Updates the plane's progress during flying, set on a timer
 */
var progTimer = setInterval(updateProgress, 5000);
function updateProgress () {
	var lat1 = ges.aircraft.llaLocation[0] || 0;
	var lon1 = ges.aircraft.llaLocation[1] || 0;
	var lat2 = arrival[1] || 0;
	var lon2 = arrival[2] || 0;
	var times = ["--", "--", "--", "--", "--"]; // flightete, flighteta, todete, todeta, nextete
	var nextdist = getRouteDistance(fmc.waypoints.nextWaypoint);
	if (nextdist < 10) {
		nextdist = (Math.round(10 * nextdist)) / 10;
	} else nextdist = Math.round(nextdist);
	var flightdist;
	for (var i = 0, test = true; i < fmc.waypoints.route.length; i++) {
		if (!fmc.waypoints.route[i][1]) test = false;
	}
	if (test) flightdist = getRouteDistance(fmc.waypoints.route.length + 1);
	else flightdist = fmc.math.getDistance(lat1, lon1, lat2, lon2);
	var aircraft = ges.aircraft.name;

	if (!ges.aircraft.groundContact && arrival) {
		times[0] = getete(flightdist, true);
		times[1] = geteta(times[0][0], times[0][1]);
		times[4] = getete(nextdist, false);
		if ((flightdist - tod) > 0) {
			times[2] = getete((flightdist - tod), false);
			times[3] = geteta(times[2][0], times[2][1]);
		}
	}
	print(flightdist, nextdist, times);
}

/**
 * Controls LNAV, plane's lateral navigation, set on a timer
 */
var LNAVTimer = setInterval(updateLNAV, 5000);
function updateLNAV () {
	var d = getRouteDistance(fmc.waypoints.nextWaypoint);
	if (d <= getTurnDistance(60)) {
		activateLeg(fmc.waypoints.nextWaypoint + 1);
	}
	clearInterval(LNAVTimer);
	if (d < ges.aircraft.animationValue.kias / 60) LNAVTimer = setInterval(updateLNAV, 500);
	else LNAVTimer = setInterval(updateLNAV, 30000);
}

/**
 * Controls VNAV, plane's vertical navigation, set on a timer
 */
var VNAVTimer;
function updateVNAV () {
	var route = fmc.waypoints.route;
	
	var params = getFlightParameters();
	
	var next = getNextWaypointWithAltRestriction();
	var hasRestriction = next !== -1;
	
	var currentAlt = ges.aircraft.animationValue.altitude;
	var targetAlt, deltaAlt, nextDist, targetDist;
	if (hasRestriction) {
		targetAlt = route[next - 1][3];
		deltaAlt = targetAlt - currentAlt;
		nextDist = getRouteDistance(next);
		targetDist = getTargetDist(deltaAlt);
		console.log('targetAlt: ' + targetAlt + ', deltaAlt: ' + deltaAlt + ', nextDist: ' + nextDist + ', targetDist: ' + targetDist);
	}
	
	var spd, vs, alt;
	var tSpd = $('#tSpd').hasClass('btn-warning');
	if (tSpd) spd = params[0];

	// If the aircraft is climbing
	if (phase == "climb") {
	
		// If there is an altitude restriction somewhere on the route
		if (hasRestriction) {
			var totalDist = getTargetDist(cruise - currentAlt) + getTargetDist(targetAlt - cruise);
		
			// Checks to see if the altitude restriction is on the climbing phase or descent phase
			if (nextDist < totalDist) {
				if (nextDist < targetDist) vs = fmc.math.getClimbrate(deltaAlt, nextDist);
				else vs = params[1];
				alt = targetAlt;
			} else {
				vs = params[1];
				alt = cruise;
			}
		}
	
		// If there are no altitude restrictions left on the route
		else {
			vs = params[1];
			alt = cruise;
		}
	} 

	// If the aircraft is on descent
	else if (phase == "descent") {
	
		// If there is an altitude restriction somewhere on the route
		if (hasRestriction) {

			// If targetDist has been reached
			if (nextDist < targetDist) {
				vs = fmc.math.getClimbrate(deltaAlt, nextDist);
				alt = targetAlt;
			}
			
			// If targetDist hasn't been reached do nothing until it has been reached
		} 
	
		// If there are no altitude restrictions left on the route
		else {
		    vs = params[1];
			if (currentAlt > 12000 + fieldElev) alt = 12000 + fieldElev;
		}
	}
	
	// Calculates Top of Descent
	if (todCalc || !tod) {
		if (hasRestriction) {
			tod = getRouteDistance(route.length) - nextDist;
			tod += getTargetDist(targetAlt - cruise);
		} else {
			tod = getTargetDist(fieldElev - cruise);
		}
		tod = Math.round(tod);
		$('#todInput').val('' + tod).change();
		console.log('TOD changed to ' + tod);
	}
	
	// Updates SPD, VS, and ALT in Autopilot++ if new values exist
	if (spd) $('#Qantas94Heavy-ap-spd > input').val('' + spd).change();
	if (vs) $('#Qantas94Heavy-ap-vs > input').val('' + vs).change();
	if (alt) $('#Qantas94Heavy-ap-alt > input').val('' + alt).change();
	
	// Updates flight phase
	updatePhase();
}

/**
 * Updates plane's flight log, set on a timer
 *
 * @param [optional]{String} other Updates the log with other as extra info
 */
var logTimer = setInterval(updateLog, 120000);
function updateLog (other) {
	if (!ges.pause && !flight.recorder.playing && !flight.recorder.paused) {
		var spd = Math.round(ges.aircraft.animationValue.ktas);
		var hdg = Math.round(ges.aircraft.animationValue.heading360);
		var alt = Math.round(ges.aircraft.animationValue.altitude);
		var fps = ges.debug.fps;
		var lat = (Math.round(10000*ges.aircraft.llaLocation[0]))/10000;
		var lon = (Math.round(10000*ges.aircraft.llaLocation[1]))/10000;
		var date = new Date();
		var h = date.getUTCHours();
		var m = date.getUTCMinutes();
		var time = formatTime(timeCheck(h, m));
		other = other || "none";
		$('<tr>')
			.addClass('data')
			.append(
			$('<td>'+time+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+spd+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+hdg+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+alt+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+lat+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+lon+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+fps+'</td>')
				.css('padding','0px 10px 0px 10px')
		,	$('<td>'+other+'</td>')
				.css('padding','0px 10px 0px 10px')
			).appendTo('#logData');
	}
	clearInterval(logTimer);
	if (ges.aircraft.animationValue.altitude > 18000) {
		logTimer = setInterval(updateLog, 120000);
	} else logTimer = setInterval(updateLog, 30000);
}

/**
 * Checks for gear retraction and extension for log, set on a timer
 */
var gearTimer = setInterval(checkGear, 12000);
function checkGear () {
	if (ges.aircraft.animationValue.gearPosition !== ges.aircraft.animationValue.gearTarget) {
		if (ges.aircraft.animationValue.gearTarget === 1) updateLog('Gear Up');
		else updateLog('Gear Down');
	}
	clearInterval(gearTimer);
	if (ges.aircraft.animationValue.altitude < 10000) gearTimer = setInterval(checkGear, 12000);
	else gearTimer = setInterval(checkGear, 60000);
}

/**
 * Checks for flaps target and position for log, set on a timer
 */
var flapsTimer = setInterval(checkFlaps, 5000);
function checkFlaps () {
	if (ges.aircraft.animationValue.flapsPosition !== ges.aircraft.animationValue.flapsTarget) {
		updateLog('Flaps set to ' + ges.aircraft.animationValue.flapsTarget);
	}
}

/**
 * Checks for overspeed under 10000 feet for log, set on a timer
 */
var speedTimer = setInterval(checkSpeed, 15000);
function checkSpeed () {
	var kcas = ges.aircraft.animationValue.kcas;
	var altitude = ges.aircraft.animationValue.altitude;
	if (kcas > 255 && altitude < 10000) {
		updateLog('Overspeed');
	}
	clearInterval(speedTimer);
	if (altitude < 10000) speedTimer = setInterval(checkSpeed, 15000);
	else speedTimer = setInterval(checkSpeed, 30000);
}

/**
 * Updates plane's phase of flying: climb, cruise, or descent
 *
 * @description Phase contains "climb," "cruise," and "descent"
 * @param <restricted>[optional]{String} p Updates the phase to "p"
 * @TODO add a better logic, especially near the cruise phase
 */
function updatePhase() {
	var currentAlt = 100 * Math.round(ges.aircraft.animationValue.altitude / 100);
	if (phase === "climb" && currentAlt === Number(cruise)) {
		$('#phaseBtn').click();
	} else if (phase === "cruise") {
		var dist = getRouteDistance(fmc.waypoints.route.length + 1);
		if (currentAlt !== Number(cruise)) {
			$('#phaseBtn').click();
		} else if (dist <= tod) {
			$('#phaseBtn').click();
		}
	}
}

/**
 * Prints plane's progress to the UI
 *
 * @param {Number} flightdist The total flight distance
 * @param {Number} nextdist The distance to the next waypoint
 * @param {Array} times An array of the time: [hours, minutes]
 */
function print (flightdist, nextdist, times) {
	for (var i = 0; i < times.length; i++) {
		times[i] = formatTime(times[i]);
	}
	if (flightdist < 10) {
		flightdist = Math.round(flightdist * 10) / 10;
	} else flightdist = Math.round(flightdist);
	$('#flightete').text('ETE: ' + times[0]);
	$('#flighteta').text('ETA: ' + times[1]);
	$('#todete').text('ETE: ' + times[2]);
	$('#todeta').text('ETA: ' + times[3]);
	$('#flightdist').text(flightdist + ' nm');
	$('#externaldist').text(flightdist + ' nm');
	$('#toddist').text((flightdist - tod) + ' nm');
	$('#nextDist').text(nextdist + ' nm');
	$('#nextETE').text(times[4]);
}

/**
 * Gets each plane's flight parameters, for VNAV
 *
 * @param {String} aircraft The aircraft name
 * @return {Array} vertical speed and speed
 */
function getFlightParameters () {
	var spd, vs;
	var aircraft = ges.aircraft.name;
	var gndElev = ges.groundElevation * metersToFeet;
	var a = ges.aircraft.animationValue.altitude;
	var isMach = $('#Qantas94Heavy-ap-spd span:last-child').text().trim() === 'M.';
	var switchMode = function() {
		$('#Qantas94Heavy-ap-spd span:last-child').click();
	};

	// CLIMB
	if (phase == "climb") {
		if (a > 1500 + gndElev && a <= 4000 + gndElev) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "a380":
			case "md11":
			case "concorde":
			case "156":
			case "161":
			case "162":
			case "164":
			case "166":
			case "167":
			case "172":
			case "183":
			case "187":
			case "200":
				spd = 210;
				vs = 3000;
				break;
			default:
				break;
			}
		} else if (a > 4000 + gndElev && a <= 10000 + gndElev) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "a380":
			case "md11":
			case "concorde":
			case "156":
			case "161":
			case "162":
			case "164":
			case "166":
			case "167":
			case "172":
			case "183":
			case "187":
			case "200":
				spd = 245;
				vs = 2500;
				break;
			default:
				break;
			}
		} else if (a > 10000 + gndElev && a <= 18000) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "a380":
			case "md11":
			case "concorde":
			case "156":
			case "161":
			case "164":
			case "167":
			case "172":
			case "183":
			case "187":
				spd = 295;
				vs = 2200;
				break;
			case "162":
			case "166":
			case "200":
				spd = 290;
				vs = 2200;
				break;
			default:
				break;
			}
		} else if (a > 18000 && a <= 24000) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "concorde":
			case "a380":
			case "156":
			case "161":
			case "167":
			case "172":
			case "183":
				spd = 310;
				vs = 1800;
				break;
			case "md11":
			case "164":
			case "187":
				spd = 300;
				vs = 1800;
				break;
			case "162":
			case "166":
			case "200":
				spd = 295;
				vs = 1800;
				break;
			default:
				break;
			}
		} else if (a > 24000 && a <= 26000) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "a380":
			case "156":
			case "161":
			case "167":
			case "172":
				vs = 1500;
				break;
			default:
				break;
			}
		} else if (a > 26000 && a <= 28000) {
			if (isMach) switchMode();
			switch (aircraft) {
			case "md11":
			case "162":
			case "164":
			case "166":
			case "183":
			case "187":
			case "200":
				vs = 1500;
				break;
			default:
				break;
			}
		} else if (a > 29500) {
			if (!isMach) switchMode();
			switch (aircraft) {
			case "162":
			case "166":
			case "200":
				spd = 0.76;
				break;
			case "a380":
			case "156":
			case "161":
			case "167":
			case "172":
				spd = 0.82;
				break;
			case "md11":
			case "164":
			case "187":
				spd = 0.78;
				vs = 1200;
				break;
			case "183":
				spd = 0.80;
				break;
			default:
				break;
			}
		}
		if (a > cruise - 100 && cruise > 18000) {
			if (!isMach) switchMode();
			switch (aircraft) {
			case "162":
				spd = 0.785;
				break;
			case "166":
			case "200":
				spd = 0.78;
				break;
			case "161":
			case "172":
				spd = 0.84;
				break;
			case "a380":
			case "156":
			case "167":
				spd = 0.85;
				break;
			case "md11":
			case "164":
			case "187":
				spd = 0.80;
				break;
			case "183":
				spd = 0.82;
				break;
			case "concorde":
				spd = 2;
				break;
			default:
				break;
			}
		}
	}

	// DESCENT
	else if (phase == "descent") {
		if (a > cruise - 700 && cruise >= 31000) {
			if (!isMach) switchMode();
			vs = -1000;
		} else {
			if (a > 45000) {
				if (!isMach) switchMode();
				switch (aircraft) {
				case "concorde":
					spd = 1.5;
					vs = -2000;
					break;
				default:
					break;
				}
			} else if (a > 30000 && a <= 45000) {
				if (!isMach) switchMode();
				switch (aircraft) {
				case "concorde":
					vs = -3600;
					break;
				case "a380":
				case "156":
				case "161":
				case "167":
				case "172":
					spd = 0.83;
					vs = -2400;
					break;
				case "183":
					spd = 0.81;
					vs = -2300;
					break;
				case "md11":
				case "162":
				case "164":
				case "166":
				case "187":
				case "200":
					spd = 0.77;
					vs = -2300;
					break;
				default:
					break;
				}
			} else if (a > 18000 && a < 30000) {
				if (isMach) switchMode();
				switch (aircraft) {
				case "162":
				case "166":
				case "200":
					spd = 295;
					vs = -2100;
					break;
				case "a380":
				case "md11":
				case "156":
				case "161":
				case "164":
				case "167":
				case "172":
				case "183":
				case "187":
					spd = 310;
					vs = -2200;
					break;
				case "concorde":
					spd = 330;
					vs = -2400;
					break;
				default:
					break;
				}
			} else if (a > 12000 + fieldElev && a <= 18000) {
				if (isMach) switchMode();
				switch (aircraft) {
				case "a380":
				case "md11":
				case "concorde":
				case "156":
				case "161":
				case "162":
				case "164":
				case "166":
				case "167":
				case "172":
				case "183":
				case "187":
				case "200":
					spd = 280;
					vs = -1800;
					break;
				default:
					break;
				}
			}
		}
	}

	return [spd, vs];
}

/**
 * Activates a waypoint or deactivates if the waypoint is already activated
 *
 * @param {Number} n The index to be activated or deactivated
 */
function activateLeg (n) {
	if (fmc.waypoints.nextWaypoint != n) {
		if (n <= fmc.waypoints.route.length) {
			fmc.waypoints.nextWaypoint = n;
			var wpt = fmc.waypoints.route[fmc.waypoints.nextWaypoint - 1];
			if (wpt[4]) {
				$('#Qantas94Heavy-ap-icao > input').val(wpt[0]).change();
			} else {
				$('#Qantas94Heavy-ap-gc-lat > input').val(wpt[1]).change();
				$('#Qantas94Heavy-ap-gc-lon > input').val(wpt[2]).change();
			}
			$('.activate').removeClass('btn-warning');
			$('#waypoints tr:nth-child(' + (n + 1) + ') .btn').addClass('btn-warning');
		} else {
			$('#Qantas94Heavy-ap-icao > input').val(arrival[0]).change();
			$('.activate').removeClass('btn-warning');
		}
		console.log('Waypoint activated');
	} else {
		$('.activate').removeClass('btn-warning');
		fmc.waypoints.nextWaypoint = undefined;
		$('#Qantas94Heavy-ap-icao > input').val('').change();
	}
}

/**
 * Gets the next waypoint that has an altitude restriction
 *
 * @return The index of the waypoint if eligible,
 * 		   -1 if not eligible
 */
function getNextWaypointWithAltRestriction () {
	for (var i = fmc.waypoints.nextWaypoint; i <= fmc.waypoints.route.length; i++) {
		if (fmc.waypoints.route[i - 1][3]) return i;
	}
	return -1;
}

/**
 * Helper method for log, formats the time
 * 
 * @param {Array} time An array of the time: [hours, minutes]
 * @return {String} Formatted time: "hours : minutes"
 */
function formatTime (time) {
	time[1] = checkZeros(time[1]);
	return time[0] + ":" + time[1];
}

/**
 * Helper method, format zeros
 *
 * @param {Number} i The number to be checked
 * @return {String} The original number with 0's added
 */
function checkZeros (i) {
	if (i < 10) i = "0" + i;
	return i;
}

/**
 * Helper method to make sure that a time is eligible
 *
 * @param {Number} h The hours
 * @param {Number} m The minutes
 * @return {Array} Array of eligible time, [h, m]
 */
function timeCheck (h, m) {
	if (m >= 60) {
		m -= 60;
		h++;
	}
	if (h >= 24) h -= 24;
	return [h, m];
}

/**
 * Gets "Estimated Time En-Route"
 *
 * @param {Number} The distance to the destination
 * @param {Boolean} a Is the aircraft in arrival
 * @return {Array} The time after <code>timeCheck(h, m)</code>
 */
function getete (d, a) {
	var hours = d / ges.aircraft.animationValue.ktas;
	var h = parseInt(hours);
	var m = Math.round(60 * (hours - h));
	if (a) m += Math.round(ges.aircraft.animationValue.altitude / 4000);
	return timeCheck(h, m);
}

/**
 * Gets "Estimated Time of Arrival"
 *
 * @param {Number} hours Hours
 * @param {Number} minutes Minutes
 * @return {Array} The timer after <code>timeCheck(hours, minutes)</code>
 */
function geteta (hours, minutes) {
	var date = new Date();
	var h = date.getHours();
	var m = date.getMinutes();
	h += hours;
	m += Number(minutes);
	return timeCheck(h, m);
}

/**
 * Computes the full route distance with waypoints until index
 * 
 * @param {Number} end The index of the end of the route to be calculated
 * @return {Number} The route distance
 */
function getRouteDistance (end) {
	var loc = ges.aircraft.llaLocation || [0, 0, 0];
	var start = fmc.waypoints.nextWaypoint || 0;
	var route = fmc.waypoints.route;
	var total;
	if (route.length === 0 || !fmc.waypoints.nextWaypoint) {
		total = fmc.math.getDistance(loc[0], loc[1], arrival[1], arrival[2]);
	} else {
		total = fmc.math.getDistance(loc[0], loc[1], route[start - 1][1], route[start - 1][2]);
		for (var i = start; i < end && i < route.length; i++) {
			total += fmc.math.getDistance(route[i - 1][1], route[i - 1][2], route[i][1], route[i][2]);
		}
		if (end > route.length) {
			total += fmc.math.getDistance(route[route.length - 1][1], route[route.length - 1][2], arrival[1], arrival[2]);
		}
	}
	return total;
}

/**
 * Computes the distance needed to climb or descend to a certain altitude from current altitude
 * 
 * @param {Number} deltaAlt The altitude difference
 * @return {Number} The distance
 */
function getTargetDist (deltaAlt) {
	var targetDist;
	if (deltaAlt < 0) {
		targetDist = deltaAlt / -1000 * 3.4;
	} else {
		targetDist = deltaAlt / 1000 * 2.5;
	}
	return targetDist;
}

/**
 * Computes the turning distance to next waypoint for an aircraft to be on course
 * 
 * @param {Number} angle Angle of turning
 * @return {Number} The turning distance
 */
function getTurnDistance(angle) {
	var v = ges.aircraft.animationValue.kcas;
	var r = 0.107917 * Math.pow(Math.E, 0.0128693 * v);
	var a = fmc.math.toRadians(angle);
	return r * Math.tan(a / 2) + 0.20;
}

/**
 * Computes the ground speed of the aircraft
 * 
 * @return {Number} The ground speed of the aircraft
 */
fmc.math.getGroundSpeed = function () {
	var tas = ges.aircraft.animationValue.ktas;
	var vs = (60 * ges.aircraft.animationValue.climbrate) * feetToNM;
	console.log("tas: " + tas + ", vs: " + vs);
	return Math.sqrt(tas * tas - vs * vs);
};

/**
 * Computes the climb rate with an altitude restriction
 * 
 * @param {Number} deltaAlt The altitude difference
 * @param {Number} nextDist The distance to the restriction point
 * @return {Number} The climb rate necessary to attain the restriction
 */
fmc.math.getClimbrate = function (deltaAlt, nextDist) {
	var gs = fmc.math.getGroundSpeed();
	var vs = 100 * Math.round((gs * (deltaAlt / (nextDist * nmToFeet)) * nmToFeet / 60) / 100);
	return vs;
};

/**
 * Computes the distance between two sets of coordinates
 * 
 * @param {Number} lat1 Latitude of first coordinate
 * @param {Number} lon1 Longetude of first coordinate
 * @param {Number} lat2 Latitude of second coordinate
 * @param {Number} lon2 Longetude of second coordinate
 * @return {Number} The distance computed, in nautical miles
 */
fmc.math.getDistance = function (lat1, lon1, lat2, lon2) {
	var math = fmc.math;
	var dlat = math.toRadians(lat2 - lat1);
	var dlon = math.toRadians(lon2 - lon1);
	lat1 = math.toRadians(lat1);
	lat2 = math.toRadians(lat2);
	var a = Math.sin(dlat / 2) * Math.sin(dlat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
	var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return math.earthRadiusNM * c;
};

/**
 * Computes the bearing between two sets of coordinates
 * 
 * @param {Number} lat1 Latitude of first coordinate
 * @param {Number} lon1 Longetude of first coordinate
 * @param {Number} lat2 Latitude of second coordinate
 * @param {Number} lon2 Longetude of second coordinate
 * @return {Number} The bearing computed, in degrees 360 format
 */
fmc.math.getBearing = function (lat1, lon1, lat2, lon2) {
	var math = fmc.math;
	lat1 = math.toRadians(lat1);
	lat2 = math.toRadians(lat2);
	lon1 = math.toRadians(lon1);
	lon2 = math.toRadians(lon2);
	var y = Math.sin(lon2 - lon1) * Math.cos(lat2);
	var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
	var brng = math.toDegrees(Math.atan2(y, x));
	return brng;
};

/**
 * Accesses autopilot_pp library and find the coordinates for the waypoints
 * 
 * @param {String} wpt The waypoint to check for eligibility
 * @return {Array} Array of coordinates if eligible, 
 *         {Boolean} false otherwise
 */
fmc.waypoints.getCoords = function (wpt) {
	if (autopilot_pp.require('icaoairports')[wpt]) {
		return autopilot_pp.require('icaoairports')[wpt];
	} else if (autopilot_pp.require('waypoints')[wpt]) {
		return autopilot_pp.require('waypoints')[wpt];
	} else return false;
};

/**
 * Turns the coordinate entered from minutes-seconds format to decimal format
 * 
 * @param {String} a Coordinate in minutes-seconds format
 * @return {Number} Coordinate in decimal format
 */
fmc.waypoints.formatCoords = function (a) {
	if (a.indexOf(' ') > -1) {
		var array = a.split(' ');
		var d = Number(array[0]);
		var m = Number(array[1]) / 60;
		var coords;
		if (d < 0) coords = d - m;
		else coords = d + m;
		return coords;
	} else return Number(a);
};

/**
 * Turns a SkyVector link, normal waypoints input, or shared waypoints string into waypoints
 * 
 * @param {String} url A SkyVector Link, an input of waypoints, or a shared/generated route
 */
fmc.waypoints.toRoute = function (url) {
	if (url.indexOf('["') === 0) fmc.waypoints.loadFromSave(url);
	else {
		var index = url.indexOf('fpl=');
		var isSkyvector = url.indexOf('skyvector.com') !== -1 && index !== -1;
		var isWaypoints = true;
		var departure = $('#wptDeparture')[0].checked;
		var arrival = $('#wptArrival')[0].checked;
		var n = $('#waypoints tbody tr').length - 1;
		var a;
		var str = [];

		if (isSkyvector) str = url.substring(index + 4).trim().split(" ");
		else {
			str = url.trim().toUpperCase().split("%20");
			for (var i = 0; i < str.length; i++)
				if (str[i].length > 5 || str[i].length < 1 || !(/^\w+$/.test(str[i])))
					isWaypoints = false;
		}

		if (isSkyvector || isWaypoints) {
			for (var i = 0; i < n; i++) {
				fmc.waypoints.removeWaypoint(1);
			}
			fmc.waypoints.route = [];

			if (departure) {
				var wpt = str[0];
				$('#departureInput').val(wpt).change();
				a = 1;
			} else {
				a = 0;
				$('#departureInput').val("").change();
			}
			for (var i = 0; i + a < str.length; i++) {
				fmc.waypoints.addWaypoint();
				var wpt = str[i + a];
				$('#waypoints input.wpt:eq(' + i + ')').val(wpt).change();
			}
			if (arrival) {
				var wpt = str[str.length - 1];
				$('#arrivalInput').val(wpt).change();
			}
		} else {
			if (!isWaypoints) {
				if (!isSkyvector) alert("Invalid Skyvector Link");
				else alert("Invalid Waypoints Input");
			}
		}
	}
};

/**
 * Adds 1 waypoint input field
 */
fmc.waypoints.addWaypoint = function () {
	var waypoints = fmc.waypoints;
	waypoints.route.length++;
	var n = waypoints.route.length;
	waypoints.route[waypoints.route.length - 1] = [];
	$('<tr>')
		.addClass('waypoint')
		.append(

			// Waypoint
			$('<td>')
			.append(
				$('<div>')
				.addClass('input-prepend input-append')
				.append(
					$('<input>')
					.addClass('input-medium')
					.addClass('wpt')
					.css('width', '75px')
					.attr('type', 'text')
					.attr('placeholder', 'Fix/Apt.')
					.change(function() {
						var n = $(this).val();
						var coords = waypoints.getCoords(n);
						var index = $(this).parents().eq(2).index() - 1;
						if (!coords) {
							waypoints.route[index][0] = n;
							waypoints.route[index][4] = false;
						} else {
							$(this).parents().eq(2).children('.position').children('div').children('.lat').val(coords[0]);
							$(this).parents().eq(2).children('.position').children('div').children('.lon').val(coords[1]);
							waypoints.route[index] = [n, coords[0], coords[1], undefined, true];
						}
					})
				)
			)

			// Position
			, $('<td>')
			.addClass('position')
			.append(
				$('<div>')
				.addClass('input-prepend input-append')
				.append(
					$('<input>')
					.addClass('input-medium lat')
					.css('width', '80px')
					.attr({
						'type': 'text',
						'tabindex': '-1'
					})
					.change(function() {
						var index = $(this).parents().eq(2).index() - 1;
						waypoints.route[index][1] = waypoints.formatCoords($(this).val());
						waypoints.route[index][4] = false;
					}), $('<input>')
					.addClass('input-medium lon')
					.css('width', '80px')
					.attr({
						'type': 'text',
						'tabindex': '-1'
					})
					.change(function() {
						var index = $(this).parents().eq(2).index() - 1;
						waypoints.route[index][2] = waypoints.formatCoords($(this).val());
						waypoints.route[index][4] = false;
					})
				)
			)

			// Altitude
			, $('<td>')
			.addClass('altitude')
			.append(
				$('<div>')
				.addClass('input-prepend input-append')
				.append(
					$('<input>')
					.addClass('input-medium alt')
					.css('width', '40px')
					.attr({
						'type': 'text',
						'tabindex': '-1',
						'placeholder': 'Ft.'
					})
					.change(function() {
						var index = $(this).parents().eq(2).index() - 1;
						waypoints.route[index][3] = Number($(this).val());
					})
				)
			)

			// Actions
			, $('<td>')
			.append(
				$('<div>')
				.addClass('input-prepend input-append')
				.append(

					// Activate
					$('<button>')
					.attr('type', 'button')
					.addClass('btn btn-standard activate')
					.text('Activate')
					.click(function() {
						var n = $(this).parents().eq(2).index();
						activateLeg(n);
					})

					// Shift up
					, $('<button>')
					.attr('type', 'button')
					.addClass('btn btn-info')
					.append($('<i>').addClass('icon-arrow-up'))
					.click(function() {
						var row = $(this).parents().eq(2);
						fmc.waypoints.shiftWaypoint(row, row.index(), "up");
					})

					// Shift down
					, $('<button>')
					.attr('type', 'button')
					.addClass('btn btn-info')
					.append($('<i>').addClass('icon-arrow-down'))
					.click(function() {
						var row = $(this).parents().eq(2);
						fmc.waypoints.shiftWaypoint(row, row.index(), "down");
					})

					// Remove
					, $('<button>')
					.attr('type', 'button')
					.addClass('btn btn-danger')
					.append($('<i>').addClass('icon-remove'))
					.click(function() {
						var n = $(this).parents().eq(2).index();
						waypoints.removeWaypoint(n);
					})
				)
			)
		).appendTo('#waypoints');
};

/**
 * Removes a waypoint
 * 
 * @param {Number} n The index of which will be removed
 */
fmc.waypoints.removeWaypoint = function (n) {
	$('#waypoints tr:nth-child(' + (n + 1) + ')').remove();
	fmc.waypoints.route.splice((n - 1), 1);
	if (fmc.waypoints.nextWaypoint == n) {
		fmc.waypoints.nextWaypoint = null;
	}
};

/**
 * Saves the waypoints data into localStorage
 */
fmc.waypoints.saveData = function () {
	if (fmc.waypoints.route.length < 1 || !fmc.waypoints.route[0][0]) {
		alert ("There is no route to save");
	} else {
		localStorage.removeItem('fmcWaypoints');
		var arr = fmc.waypoints.toRouteString();
		localStorage.setItem ("fmcWaypoints", arr);
	}
};

/**
 * Retrieves the saved data and adds to the waypoint list
 *
 * @param {String} arg The generated route
 */
fmc.waypoints.loadFromSave = function (arg) {
	
/**
 * The argument passed in [optional] or the localStorage is a 
 * 3D array in String format. arr is the array after JSON.parse 
 *	
 * @param {String} arr[0] Departure input
 * @param {String} arr[1] Arrival Input
 * @param {String} arr[2] Flight Number
 * @param {Array} arr[3] 2D array, the route
 */
	
	arg = arg || localStorage.getItem('fmcWaypoints');
	var waypoints = fmc.waypoints;
	var arr = JSON.parse(arg);
	localStorage.removeItem('fmcWaypoints');
	
	if (arr) {
		waypoints.route = [];
		var route = arr[3];
		var n = $('#waypoints tbody tr').length - 1;
		for (var i = 0; i < n; i++) {
			waypoints.removeWaypoint(1);
		}
		// JSON.stringify turns undefined into null; this loop turns it back
		route.forEach(function (wpt) {
			if (!wpt[3] || wpt[3] == null || wpt[3] == 0) wpt[3] = undefined;
		});
		
		if (arr[0]) $('#departureInput').val(arr[0]).change();
		if (arr[1]) $('#arrivalInput').val(arr[1]).change();
		if (arr[2]) $('#flightNumInput').val(arr[2]).change();
		
		for (var i = 0; i < route.length; i++) {
			waypoints.addWaypoint();
			$('#waypoints input.wpt:eq(' + i + ')').val(route[i][0]).change(); // Input the fix
			
			// If the waypoint is not eligible or a duplicate
			if (!route[i][4] || !$('#waypoints input.lat:eq(' + i + ')').val()) {
				$('#waypoints input.lat:eq(' + i + ')').val(route[i][1]).change(); // Input the lat.
				$('#waypoints input.lon:eq(' + i + ')').val(route[i][2]).change(); // Input the lon.
			}
			
			if (route[i][3]) // If there is an altitude restriction
				$('#waypoints input.alt:eq(' + i + ')').val(route[i][3]).change();
		}
		// Auto-saves the data once again
		waypoints.saveData();
		
	} else alert ("You did not save the waypoints or you cleared the browser's cache");
};

/**
 * Shifts a waypoint up or down one step
 *
 * @param {jQuery element} r The element to be moved in the UI
 * @param {Number} n Index of this waypoint
 * @param <restricted>{String} d Direction of shifting, "up" or "down"
 */
fmc.waypoints.shiftWaypoint = function(r, n, d) {
	var waypoints = fmc.waypoints;
	console.log("Waypoint #" + n + " moved " + d);
	if (!(d == "up" && n == 1 || d == "down" && n == waypoints.route.length)) {
		if (d == "up") {
			waypoints.route.move(n - 1, n - 2);
			r.insertBefore(r.prev());
			if (waypoints.nextWaypoint == n) {
				waypoints.nextWaypoint = n - 1;
			} else if (waypoints.nextWaypoint == n - 1) {
				waypoints.nextWaypoint = n + 1;
			}
		} else {
			waypoints.route.move(n - 1, n);
			r.insertAfter(r.next());
			if (waypoints.nextWaypoint == n) {
				waypoints.nextWaypoint = n + 1;
			} else if (waypoints.nextWaypoint == n + 1) {
				waypoints.nextWaypoint = n - 1;
			}
		}
	}
}

// Adds a confirm window to prevent accidental reset
ges.resetFlight = function () {
	if (window.confirm('Reset Flight?')) {
		if (ges.lastFlightCoordinates) {
			ges.flyTo(ges.lastFlightCoordinates, true);
			updateLog('Flight reset');
		}
	}
};

// Tracks pause event to log
ges.togglePause = function () {
	if (!ges.pause) {
		updateLog('Flight paused');
		ges.doPause();
	} else {
		ges.undoPause();
		updateLog('Flight resumed');
	}
};

// FMC html elements
fmc.ui = {
// FMC modal UI
modal: $('<div>')
	.addClass('modal hide gefs-stopPropagation')
	.attr('data-backdrop', 'static')
	.attr('id', 'fmcModal')
	.attr('tabindex', '-1')
	.attr('role', 'dialog')
	.attr('aria-labelledby', 'fmcDialogBoxLabel')
	.attr('aria-hidden', 'true')
	.css('width', '590px')
	.append(

	// Dialog
	$('<div>')
		.addClass('modal-dialog')
		.append(

		// Content
		$('<div>')
			.addClass('modal-content')
			.append(

			// Header
			$('<div>')
				.addClass('modal-header')
				.append(
				$('<button>')
					.addClass('close')
					.attr('type', 'button')
					.attr('data-dismiss', 'modal')
					.attr('aria-hidden', 'true')
					.text('\xD7') // &times;
			,	$('<h3>')
					.addClass('modal-title')
					.attr('id', 'myModalLabel')
					.css('text-align', 'center')
					.text('Flight Management Computer')
				)

			// Body
		,	$('<div>')
				.addClass('modal-body')
				.append(

				// Navigation tabs
				$('<ul>')
					.addClass('nav nav-tabs')
					.append(
						$('<li>')
							.addClass('active')
							.append('<a href="#rte" data-toggle="tab">RTE</a>')
					,	$('<li>')
							.append('<a href="#arr" data-toggle="tab">DEP/ARR</a>')
					/*,	$('<li>')
							.append('<a href="#perf" data-toggle="tab">PERF</a>')*/
					,	$('<li>')
							.append('<a href="#vnav" data-toggle="tab">VNAV</a>')
					,	$('<li>')
							.append('<a href="#prog" data-toggle="tab">PROG</a>')
					,	$('<li>')
							.append('<a href="#load" data-toggle="tab">LOAD</a>')
					/*,	$('<li>')
							.append('<a href-"#save" data-toggle="tab">SAVE</a>')*/
					,	$('<li>')
							.append('<a href="#log" data-toggle="tab">LOG</a>')
					)

				// Tab Content
			,	$('<div>')
					.addClass('tab-content')
					.css('padding', '5px')
					.append(

					// ROUTE TAB
					$('<div>')
						.addClass('tab-pane active')
						.attr('id', 'rte')
						.append(
						$('<table>')
							.append(
							$('<tr>')
								.append(
								$('<table>')
									.append(
									$('<tr>')
										.append(
			
										// Departure Airport input
										$('<td>')
											.css('padding', '5px')
											.append(
											$('<div>')
												.addClass('input-prepend input-append')
												.append(
												$('<span>')
													.addClass('add-on')
													.text('Departure')
											,	$('<input>')
													.addClass('input-mini')
													.attr('id','departureInput')
													.attr('type', 'text')
													.attr('placeholder', 'ICAO')
												)
											)
		
										// Arrival Airport input
									,	$('<td>')
											.css('padding', '5px')
											.append(
											$('<div>')
												.addClass('input-prepend input-append')
												.append(
												$('<span>')
													.addClass('add-on')
													.text('Arrival')
											,	$('<input>')
													.addClass('input-mini')
													.attr('type', 'text')
													.attr('id','arrivalInput')
													.attr('placeholder', 'ICAO')
													.change(function() {
														var wpt = $(this).val();
														var coords = fmc.waypoints.getCoords(wpt);
														if (!coords) {
															alert('Invalid Airport code');
															$(this).val('');
														}
														else arrival = [wpt, coords[0], coords[1]];
													})
												)
											)
			
										// Flight # input
									,	$('<td>')
											.css('padding', '5px')
											.append(
											$('<div>')
												.addClass('input-prepend input-append')
												.append(
												$('<span>')
													.addClass('add-on')
													.text('Flight #'), $('<input>')
													.addClass('input-mini')
													.attr('id', 'flightNumInput')
													.css('width', '80px')
													.attr('type', 'text')
												)
											)
										)
									)
								)
							
							// Waypoints list labels
						,	$('<tr>')
								.append(
								$('<table>')
									.attr('id','waypoints')
									.append( 
									$('<tr>')
										.append(
										$('<td>').append('<th>Waypoints</th>')
									,	$('<td>').append('<th>Position</th>')
									,	$('<td>').append('<th>Altitude</th>')
									,	$('<td>').append('<th>Actions</th>')
										)
									)
								)
								
							// Add Waypoint
						,	$('<tr>')
								.append(
								$('<div>')
									.attr('id','waypointsAddDel')
									.append(
									$('<table>')
										.append(
										$('<tr>')
											.append(
											$('<td>')
												.append(
												$('<button>')
													.addClass('btn btn-primary')
													.attr('type', 'button')
													.text('Add Waypoint ')
													.append( $('<i>').addClass('icon-plus'))
													.click(function() {
														fmc.waypoints.addWaypoint();
													})
													.css('margin-right', '3px')
												)
											)
										)
									)
								)
								
							// Save Route	
						,	$('<tr>')
								.append(
								$('<div>')
									.attr('id','saveRoute')
									.append(
									$('<table>')
										.append(
										$('<tr>')
											.append(
											$('<td>')
												.append(
												$('<button>')
													.addClass('btn btn-info')
													.attr('type', 'button')
													.text('Save Route ')
													.append( $('<i>').addClass('icon-file icon-white'))
													.click(function() {
														fmc.waypoints.saveData();
													})
													.css('margin-right', '3px')
											,	$('<button>')
													.addClass('btn btn-info')
													.attr('type', 'button')
													.text('Retrieve Route ')
													.append( $('<i>').addClass('icon-refresh icon-white'))
													.click(function() {
														fmc.waypoints.loadFromSave();
													})
												)
											)
										)
									)
								)
							)
						)
						
					// ARRIVAL TAB
				,	$('<div>')
						.addClass('tab-pane')
						.attr('id', 'arr')
						.append(
						$('<table>')
							.append(
							$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('TOD Dist.')
									,	$('<input>')
											.attr('id', 'todInput')
											.attr('type', 'number')
											.attr('min', '0')
											.attr('placeholder', 'nm')
											.css('width', '38px')
											.change(function() {
												tod = $(this).val();
											})
										)
									)
							,	$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('Automatically calculate TOD')
									,	$('<button>')
											.addClass('btn btn-standard')
											.attr('type', 'button')
											.text('OFF')
											.click(function() {
												if (!todCalc) {
													$(this).removeClass('btn btn-standard').addClass('btn btn-warning').text('ON');
													todCalc = true;
												} else {
													$(this).removeClass('btn btn-warning').addClass('btn btn-standard').text('OFF');
													todCalc = false;
												}
											})
										)
									)
								)
						,	$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('Arrival Field Elev.')
									,	$('<input>')
											.attr('type','number')
											.attr('placeholder','ft.')
											.css('width','55px')
											.change(function() {
												fieldElev = Number($(this).val());
											})
										)
									)
								)
							)
						)

					// VNAV tab
				,	$('<div>')
						.addClass('tab-pane')
						.attr('id','vnav')
						.append(
							
						// AUTO-CLIMB/DESCENT, CRUISE ALT ROW, PHASE, TOGGLE
						$('<table>')
							.append(
							$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<div>')
    								.addClass('input-prepend input-append')
   							 		.append(
        						 		$('<button>')
        									.addClass('btn')
        									.attr('id', 'vnavButton')
        									.text('VNAV ')
        									.append($('<i>').addClass('icon icon-resize-vertical'))
        									.click(function () {
        										toggleVNAV();
        									})
									, 	$('<span>')
        									.addClass('add-on')
        									.text('Cruise Alt.')
									, 	$('<input>')
        									.attr('type', 'number')
        									.attr('step', '100')
        									.attr('min', '0')
        									.attr('max', '100000')
        									.attr('placeholder', 'ft')
        									.css('width', '80px')
        									.change(function () {
            									cruise = Number( $(this).val());
            									console.log("Cruise Alt set to " + cruise + " ft.");
        									})
    									)
									)
								)	
						,	$('<tr>')
								.append(
								
								// Flight Phase
								$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('Phase')
									,	$('<button>')
											.addClass('btn btn-info')
											.attr('id', 'phaseBtn')
											.text('Climb')
											.css('height', '30px')
											.css('width', '77px')
											.click(function() {
												if ( $('#phaseLock').hasClass('btn-default')) {
													if (phase == "climb") {
														$(this).text("Cruise");
														phase = "cruise";
													} else if (phase == "cruise") {
														$(this).text("Descent");
														phase = "descent";
													} else {
														$(this).text("Climb");
														phase = "climb";
													}
													console.log("Phase set to " + phase)
												}
											})
									,	$('<button>')
											.addClass('btn btn-default')
											.attr('id', 'phaseLock')
											.append($('<i class="icon-lock"></i>'))
											.click(function() {
												if ($(this).hasClass('btn-default')) {
													$(this).removeClass('btn-default').addClass('btn-danger');
													console.log('Flight phase locked');
												} else {
													$(this).removeClass('btn-danger').addClass('btn-default');
													console.log('Flight phase unlocked');
												}
											})
										)	
									)
								
								// SPD Toggle Button
							,	$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
												$('<span>')
													.addClass('add-on')
													.text('SPD Control')
											,	$('<button>')
													.addClass('btn btn-warning')
													.attr('id', 'tSpd')
													.text('ON')
													.css('width', '60px')
													.click(function() {toggleSpeed();})
											)
									)
								)
							)		
						)
					
					// Progress tab
				,	$('<div>')
						.addClass('tab-pane')
						.attr('id','prog')
						.append(
						$('<table>')
							.append(
							$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('Dest')
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '53px')
											.append( $('<div>').attr('id', 'flightdist'))
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '50px')
											.append(
											$('<table>')
												.css({'position': 'relative', 'top': '-6px'})
												.append(
												$('<tr>')
													.append(
													$('<td>')
														.append(
														$('<div>')
															.attr('id', 'flightete')
															.css('font-size', '70%')
															.css('height', '10px')
														)
													)
											,	$('<tr>')
													.append(
													$('<td>')
														.append(
														$('<div>')
															.attr('id', 'flighteta')
															.css('font-size', '70%')
															.css('height', '10px')
														)
													)
												)
											)
										)
									)
							,	$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append(
										$('<span>')
											.addClass('add-on')
											.text('TOD')
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '53px')
											.append( $('<div>').attr('id', 'toddist'))
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '50px')
											.append(
											$('<table>')
												.css({'position': 'relative', 'top': '-6px'})
												.append(
												$('<tr>')
													.append( 
													$('<td>')
														.append( $
														('<div>')
															.attr('id', 'todete')
															.css('font-size', '70%')
															.css('height', '10px')
														)
													)
											,	$('<tr>')
													.append(
													$('<td>')
														.append(
														$('<div>')
															.attr('id', 'todeta')
															.css('font-size', '70%')
															.css('height', '10px')
														)
													)
												)
											)
										)
									)
								)
						,	$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<div>')
										.addClass('input-prepend input-append')
										.append( 
										$('<span>')
											.addClass('add-on')
											.text('Next Waypoint ')
											.append( $('<i>').addClass('icon-map-marker'))
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '53px')
											.append( $('<div>').attr('id', 'nextDist'))
									,	$('<span>')
											.addClass('add-on')
											.css('background-color', 'white')
											.css('width', '53px')
											.append( $('<div>').attr('id', 'nextETE'))
										)
									)
								)
							)
						)
				
					// LOAD TAB
				,	$('<div>')
						.addClass('tab-pane')
						.attr('id', 'load')
						.append(
						$('<th>Enter waypoints seperated by spaces or a generated route</th>'),
						$('<form>')
							.attr('action','javascript:fmc.waypoints.toRoute(fmc.waypoints.input);')
							.addClass('form-horizontal')
							.append(
							$('<fieldset>')
								.append(
								$('<div>')
									.addClass('input-prepend input-append')
									.append(
									$('<span>')
										.addClass('add-on')
										.text('Waypoints ')
										.append( $('<i>').addClass('icon-pencil'))
								,	$('<input>')
										.attr('type', 'text')
										.addClass('input-xlarge gefs-stopPropagation')
										.change(function() {
											fmc.waypoints.input = $(this).val();
										})
									)
							,	$('<label class = "checkbox"><input type="checkbox" id="wptDeparture" value="true" checked> First waypoint is departure airport</label>')
							,	$('<label class = "checkbox"><input type="checkbox" id="wptArrival" value="true" checked> Last waypoint is arrival airport</label>')
							,	$('<button>')
									.attr('type', 'submit')
									.addClass('btn btn-primary')
									.text('Load Route ')
									.append( $('<i>').addClass('icon-play'))
								)
								
							// Share route / generate route	
						,	$('<fieldset>')
								.css('margin-top', '10px')
								.append(
									$('<button>')
									.addClass('btn btn-warning')
									.attr('type','button')
									.text('Generate')
									.click(function() {
										$('#generateRoute').val(fmc.waypoints.toRouteString()).change();
									}), 
									$('<button>')
									.addClass('btn btn-warning')
									.attr('type','button')
									.css('margin-left', '5px')
									.text('Clear')
									.click(function() {
										$('#generateRoute').val("").change();
									}),
									$('<div>').css('margin-top', '10px').append(
										$('<textarea>')
										.attr('id', 'generateRoute')
										.attr('placeholder', 'Generate route. Save it or share it')
										.css('margin', '0px 0px 10px')
										.css('width', '350px')
										.css('height', '65px')
										.css('resize', 'none')
									)
								)
							)
						)
						
					// Log tab
				,	$('<div>')
						.addClass('tab-pane')
						.attr('id','log')
						.append(
						$('<table>')
							.attr('id','logData')
							.append(
							$('<tr>')
								.append(
								$('<th>Time</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Speed</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Heading</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Altitude</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Lat.</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Lon.</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>FPS</th>')
									.css('padding','0px 10px 0px 10px')
							,	$('<th>Other</th>')
									.css('padding','0px 10px 0px 10px')
								)
							)
					,	$('<button>')
							.addClass('btn btn-danger')
							.attr('type','button')
							.click(function() {
								removeLogData();
							})
							.text('Clear Log ')
							.append( $('<i>').addClass('icon-remove-circle'))
						)
					)
				)
			
			// Footer
		,	$('<div>')
				.addClass('modal-footer')
				.append(
				$('<button>')
					.addClass('btn btn-default')
					.attr('type', 'button')
					.attr('data-dismiss', 'modal')
					.text('Close')
			,	$('<button>')
					.addClass('btn btn-primary')
					.attr('type', 'button')
					.text('Save changes ')
					.append( $('<i>').addClass('icon-hdd'))
				)
			)
		)
,	$('<iframe frame-border="no" class="gefs-shim-iframe"></iframe>')
	).appendTo('body'),

// External distance indicator
externalDist: $('<div>')
	.addClass('setup-section')
	.css('padding-bottom','0px')
	.append( $('<div>')
		.addClass('input-prepend input-append')
		.css('margin-bottom','4px')
		.append(
		$('<span>')
			.addClass('add-on')
			.text('Dest'),
		$('<span>')
			.addClass('add-on')
			.css('background-color', 'white')
			.css('width', '53px')
			.append(
			$('<div>')
				.attr('id', 'externaldist')
			)
		)
	).appendTo('td.gefs-f-standard'), 
	
// FMC button
button: $('<button>')
	.addClass('btn btn-success gefs-stopPropagation')
	.attr('type', 'button')
	.attr('data-toggle', 'modal')
	.attr('data-target', '#fmcModal')
	.css('margin-left','1px')
	.text('FMC ')
	.append( $('<i>').addClass('icon-list-alt'))
	.appendTo('div.setup-section:nth-child(2)')
};
	
// Hides backdrop for the modal	
$('#fmcModal').modal({
	backdrop: false,
	show: false
});

// Stops immediate keyup actions in the FMC Modal
$('#fmcModal').keyup(function(event) {
	event.stopImmediatePropagation();
});

// Initializes to 1 waypoint input field on load
fmc.waypoints.addWaypoint();

/**
 * Enables VNAV if not activated, disables if activated
 */
function toggleVNAV () {
	if (VNAV) {
		VNAV = false;
		$('#vnavButton').removeClass('btn btn-warning').addClass('btn');
		clearInterval(VNAVTimer);
	} else if (cruise) {
		VNAV = true;
		$('#vnavButton').removeClass('btn').addClass('btn btn-warning');
		VNAVTimer = setInterval(updateVNAV, 5000);
	} else alert('Please enter a cruising altitude.');
}

function toggleSpeed() {
	if ($('#tSpd').hasClass('btn-warning')) {
		$('#tSpd').removeClass('btn-warning').addClass('btn-default').text('OFF');
		spdControl = false;
		
	} else {
		$('#tSpd').removeClass('btn-default').addClass('btn-warning').text('ON');
		spdControl = true;
	}
}

/**
 * Clears the log
 */
function removeLogData () {
	$('#logData tr').remove('.data');
}

/** 
 * Defines Array prototype to move an array
 *
 * @param {Number} index1 The start index
 * @param {Number} index2 The end/target index
 */
Array.prototype.move = function (index1, index2) {
	if (index2 >= this.length) {
		var k = index2 - this.length;
		while ((k--) + 1) {
			this.push(undefined);
		}
	}
	this.splice(index2, 0, this.splice(index1, 1)[0]);
	return this;
};

