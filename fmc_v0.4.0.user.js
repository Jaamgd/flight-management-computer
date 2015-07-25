// ==UserScript==
// @name FMC Extension for GEFS-Online
// @description This extension (by Ethan Shields) adds an FMC which controls other features included such as auto-climb, auto-descent, progress information, etc.
// @namespace GEFS-Plugins
// @match http://www.gefs-online.com/gefs.php*
// @match http://gefs-online.com/gefs.php*
// @run-at document-end
// @version 0.4.0.1505
// @grant none
// ==/UserScript==

// Global variables/constants
window.feetToNM = 1 / 6076;
window.nmToFeet = 6076;

// fmc library, publicly accessible methods and variables
window.fmc = {
	math: {
		toRadians: function (degrees) {
			return degrees * Math.PI / 180;
		},
		toDegrees: function (radians) {
			return radians * 180 / Math.PI;
		},
		earthRadiusNM: 3440.06
	},
	waypoints: {
		input: "",
		route: [],
		nextWaypoint: "",
		makeFixesArray: function() {
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
		toFixesString: function() {
			return fmc.waypoints.makeFixesArray().join(" ");
		}, 
		toRouteString: function() { // @TODO make loadFromSave take an argument (optional) of this format
			return JSON.stringify ([
				$('#departureInput').val(), 
				$('#arrivalInput').val(), 
				$('#flightNumInput').val(), 
				fmc.waypoints.route
			]); // .replace(/null/g, 'undefined');
		}
	}
};

var tod;
var VNAV = false;
var arrival = [];
var cruise;
var phase = "climb";
var todCalc = false;
var arrivalAlt = 0;

// Updates the plane's progress: time and location
var progTimer = setInterval(updateProgress, 5000);
function updateProgress() {
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

// Controls LNAV, plane's lateral navigation
var LNAVTimer = setInterval(updateLNAV, 5000);
function updateLNAV() {
	var d = getRouteDistance(fmc.waypoints.nextWaypoint);
	if (d <= getTurnDistance(60)) {
		activateLeg(fmc.waypoints.nextWaypoint + 1);
	}
	clearInterval(LNAVTimer);
	if (d < ges.aircraft.animationValue.kias / 60) LNAVTimer = setInterval(updateLNAV, 500);
	else LNAVTimer = setInterval(updateLNAV, 30000);
}

// Controls VNAV, plane's vertical navigation
var VNAVTimer;
function updateVNAV() {
	var aircraft = ges.aircraft.name;
	var next = getNextWaypointWithAltRestriction();
	var currentAlt = ges.aircraft.animationValue.altitude;
	var targetAlt;
	try {
		targetAlt = fmc.waypoints.route[next - 1][3];
	} catch (e) {
		targetAlt = currentAlt;
	}
	var deltaAlt = targetAlt - currentAlt;
	var nextDist = getRouteDistance(next);
	var targetDist = getTargetDist(deltaAlt);

	var params = getFlightParameters(aircraft);
	var spd = params[0];
	var vs, alt;

	if (next) {
		if (nextDist < targetDist) {
			vs = fmc.math.getClimbrate(deltaAlt, nextDist);
			alt = targetAlt;
		} else if (deltaAlt > 0) {
			var totalDist = (cruise - currentAlt) / 1000 * 2.5 + (cruise - targetAlt) / 1000 * 3.4;
			vs = params[1];
			if (nextDist < totalDist) {
				alt = targetAlt;
			} else {
				alt = cruise;
			}
		}
	} else {
		vs = params[1];
		if (phase == "climb") {
			alt = cruise;
		} else if (phase == "descent" && currentAlt > 11000) {
			alt = 11000;
		}
	}

	if (todCalc || !tod) {
		if (next) {
			tod = getRouteDistance(fmc.waypoints.route.length) - nextDist;
			tod += targetDist;
		} else {
			tod = getTargetDist(cruise - arrivalAlt);
		}
		tod = Math.round(tod);
		$('#todInput').val(tod + '').change();
	}

	if (spd) $("#Qantas94Heavy-ap-spd > input").val("" + spd).change();
	if (vs) $("#Qantas94Heavy-ap-vs > input").val("" + vs).change();
	if (alt) $("#Qantas94Heavy-ap-alt > input").val("" + alt).change();

	updatePhase();
}

// Updates plane's flight log
var logTimer = setInterval(updateLog, 120000);
function updateLog (other) {
	if (!ges.pause) {
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

// @TODO check for keydown events
// Helper method to check for gear retraction and extension
var gearTimer = setInterval(checkGear, 12000);
function checkGear() {
	if (ges.aircraft.animationValue.gearPosition !== ges.aircraft.animationValue.gearTarget) {
		if (ges.aircraft.animationValue.gearTarget === 1) updateLog('Gear Up');
		else updateLog('Gear Down');
	}
	clearInterval(gearTimer);
	if (ges.aircraft.animationValue.altitude < 10000) gearTimer = setInterval(checkGear, 12000);
	else gearTimer = setInterval(checkGear, 60000);
}

// @TODO check for keydown events
// Helper method to check for flaps target
var flapsTimer = setInterval(checkFlaps, 5000);
function checkFlaps() {
	if (ges.aircraft.animationValue.flapsPosition !== ges.aircraft.animationValue.flapsTarget) {
		updateLog('Flaps set to ' + ges.aircraft.animationValue.flapsTarget);
	}
}

// Helper method to check for overspeed under 10000 feet
var speedTimer = setInterval(checkSpeed, 15000);
function checkSpeed() {
	var kcas = ges.aircraft.animationValue.kcas;
	var altitude = ges.aircraft.animationValue.altitude;
	if (kcas > 255 && altitude < 10000) {
		updateLog('Overspeed');
	}
	clearInterval(speedTimer);
	if (altitude < 10000) speedTimer = setInterval(checkSpeed, 15000);
	else speedTimer = setInterval(checkSpeed, 30000);
}

// Updates plane's phase of flying: climb, cruise, or descent
function updatePhase() {
	var alt = 100 * Math.round(ges.aircraft.animationValue.altitude / 100);
	if (ges.aircraft.groundContact) {
		phase = "climb";
	} else {
		if (phase != "cruise" && alt == cruise) {
			phase = "cruise";
		} else if (phase == "cruise" && alt != cruise) {
			phase = "descent";
		}
	}
}

// Prints plane's progress to the UI
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

// Gets each plane's flight parameters, for VNAV
function getFlightParameters(aircraft) {
	var spd, vs;
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
			case "161":
			case "162":
			case "164":
			case "166":
			case "167":
			case "170":
			case "172":
			case "183":
			case "187":
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
			case "161":
			case "162":
			case "164":
			case "166":
			case "167":
			case "170":
			case "172":
			case "183":
			case "187":
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
			case "170":
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
			case "170":
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
			case "170":
			case "183":
			case "187":
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
			case "170":
				spd = 0.76;
				break;
			case "a380":
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
			case "166":
			case "170":
				spd = 0.78;
				break;
			case "161":
			case "172":
				spd = 0.84;
				break;
			case "a380":
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
		if (a > cruise - 700) {
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
				case "170":
				case "187":
					spd = 0.77;
					vs = -2300;
					break;
				default:
					break;
				}
			} else if (a > 18000 && a <= 30000) {
				if (isMach) switchMode();
				switch (aircraft) {
				case "162":
				case "166":
				case "170":
					spd = 295;
					vs = -2100;
					break;
				case "a380":
				case "md11":
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
			} else if (a > 12000 + gndElev && a <= 18000) {
				if (isMach) switchMode();
				switch (aircraft) {
				case "a380":
				case "md11":
				case "concorde":
				case "161":
				case "162":
				case "164":
				case "166":
				case "167":
				case "170":
				case "172":
				case "183":
				case "187":
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

// Activate a waypoint
function activateLeg (n) {
	if (fmc.waypoints.nextWaypoint != n) {
		if (n <= fmc.waypoints.route.length) {
			fmc.waypoints.nextWaypoint = n;
			var wpt = fmc.waypoints.route[fmc.waypoints.nextWaypoint - 1];
			if (wpt[3]) {
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
	} else {
		$('.activate').removeClass('btn-warning');
		fmc.waypoints.nextWaypoint = undefined;
		$('#Qantas94Heavy-ap-icao > input').val('').change();
	}
}

// Returns the next waypoint that has an altitude restriction
function getNextWaypointWithAltRestriction() {
	for (var i = fmc.waypoints.nextWaypoint; i <= fmc.waypoints.route.length; i++) {
		if (!!fmc.waypoints.route[i - 1][3]) return i;
	}
}

// Helper method for log, formats the time
function formatTime (time) {
	time[1] = checkZeros(time[1]);
	return time[0] + ":" + time[1];
}

// Helper method, format zeros
function checkZeros (i) {
	if (i < 10) i = "0" + i;
	return i;
}

// Helper method for log, check the eligibility of the time
function timeCheck (h, m) {
	if (m >= 60) {
		m -= 60;
		h++;
	}
	if (h >= 24) h -= 24;
	return [h, m];
}

// Gets "Estimated Time En-Route"
function getete (d, a) {
	var hours = d / ges.aircraft.animationValue.ktas;
	var h = parseInt(hours);
	var m = Math.round(60 * (hours - h));
	if (a) m += Math.round(ges.aircraft.animationValue.altitude / 4000);
	return timeCheck(h, m);
}

// Gets "Estimated Time of Arrival"
function geteta (hours, minutes) {
	var date = new Date();
	var h = date.getHours();
	var m = date.getMinutes();
	h += hours;
	m += Number(minutes);
	return timeCheck(h, m);
}

// Returns the full route distance, with waypoints
function getRouteDistance (end) {
	var loc = ges.aircraft.llaLocation || [0, 0, 0];
	var start = fmc.waypoints.nextWaypoint || 0;
	var total;
	if (fmc.waypoints.route.length === 0 || !fmc.waypoints.nextWaypoint) {
		total = fmc.math.getDistance(loc[0], loc[1], arrival[1], arrival[2]);
	} else {
		total = fmc.math.getDistance(loc[0], loc[1], fmc.waypoints.route[start - 1][1], fmc.waypoints.route[start - 1][2]);
		for (var i = start; i < end && i < fmc.waypoints.route.length; i++) {
			total += fmc.math.getDistance(fmc.waypoints.route[i - 1][1], fmc.waypoints.route[i - 1][2], fmc.waypoints.route[i][1], fmc.waypoints.route[i][2]);
		}
		if (end > fmc.waypoints.route.length) {
			total += fmc.math.getDistance(fmc.waypoints.route[fmc.waypoints.route.length - 1][1], fmc.waypoints.route[fmc.waypoints.route.length - 1][2], arrival[1], arrival[2]);
		}
	}
	return total;
}

// Returns the distance to start descent based on the altitude difference to the next waypoint
function getTargetDist (deltaAlt) {
	var targetDist;
	if (deltaAlt < 0) {
		targetDist = deltaAlt / -1000 * 3.4;
	} else {
		targetDist = deltaAlt / 1000 * 2.5;
	}
	return targetDist;
}

// Returns the turning distance for an aircraft to be on course
function getTurnDistance(angle) {
	var v = ges.aircraft.animationValue.kcas;
	var r = 0.107917 * Math.pow(Math.E, 0.0128693 * v);
	var a = fmc.math.toRadians(angle);
	return r * Math.tan(a / 2) + 0.20;
}

// Computes and returns the ground speed of the aircraft
fmc.math.getGroundSpeed = function() {
	var tas = ges.aircraft.animationValue.ktas;
	var vs = (60 * ges.aircraft.animationValue.climbrate) * feetToNM;
	return Math.sqrt(tas * tas - vs * vs);
};

// Computes and returns the climb rate of the aircraft
fmc.math.getClimbrate = function (deltaAlt, nextDist) {
	var gs = fmc.math.getGroundSpeed();
	var vs = 100 * Math.round((gs * (deltaAlt / (nextDist * nmToFeet)) * nmToFeet / 60) / 100);
	return vs;
};

// Returns the distance between two sets of coordinates
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

// Retuns the bearing between two coordinates
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

// Access autopilot_pp library and find the coordinates for the waypoints
fmc.waypoints.getCoords = function (wpt) {
	if (autopilot_pp.require('icaoairports')[wpt]) {
		return autopilot_pp.require('icaoairports')[wpt];
	} else if (autopilot_pp.require('waypoints')[wpt]) {
		return autopilot_pp.require('waypoints')[wpt];
	} else return false;
};

// Helper method, format the coordinates
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

// Turn a skyvector link or a normal waypoint input (seperated by spaces) to waypoints
fmc.waypoints.toRoute = function (url) {
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
		str = url.trim().toUpperCase().split(" ");
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
};

// Adds waypoint input field
fmc.waypoints.addWaypoint = function() {
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
						shiftWaypoint(row, row.index(), "up");
					})

					// Shift down
					, $('<button>')
					.attr('type', 'button')
					.addClass('btn btn-info')
					.append($('<i>').addClass('icon-arrow-down'))
					.click(function() {
						var row = $(this).parents().eq(2);
						shiftWaypoint(row, row.index(), "down");
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

// Remove waypoint at index n
fmc.waypoints.removeWaypoint = function (n) {
	$('#waypoints tr:nth-child(' + (n + 1) + ')').remove();
	fmc.waypoints.route.splice((n - 1), 1);
	if (fmc.waypoints.nextWaypoint == n) {
		fmc.waypoints.nextWaypoint = null;
	}
};

// Saves the waypoints data into localStorage
fmc.waypoints.saveData = function() {
	localStorage.removeItem('fmcWaypoints');
	if (fmc.waypoints.route) {
		var route = fmc.waypoints.route;
		var arr = JSON.stringify([$('#departureInput').val(), $('#arrivalInput').val(), $('#flightNumInput').val(), route]);
		localStorage.setItem ("fmcWaypoints", arr);
	} else alert ("There is no route to save");
};

// Retrieves the saved data and adds to the waypoint list
fmc.waypoints.loadFromSave = function() {
	var waypoints = fmc.waypoints;
	var arr = JSON.parse(localStorage.getItem('fmcWaypoints'));
	localStorage.removeItem('fmcWaypoints');
	
	if (arr) {
		var route = arr[3];
		var n = $('#waypoints tbody tr').length - 1;
		for (var i = 0; i < n; i++) {
			waypoints.removeWaypoint(1);
		}
		waypoints.route = [];
		
		if (arr[0]) $('#departureInput').val(arr[0]).change();
		if (arr[1]) $('#arrivalInput').val(arr[1]).change();
		if (arr[2]) $('#flightNumInput').val(arr[2]).change();
		
		for (var i = 0; i < route.length; i++) {
			waypoints.addWaypoint();
			$('#waypoints input.wpt:eq(' + i + ')').val(route[i][0]).change(); // Input the fix
			
			if (!$('#waypoints input.lat:eq(' + i + ')').val()) { // If fix is not eligible, input the lat./lon
				$('#waypoints input.lat:eq(' + i + ')').val(route[i][1]).change();
				$('#waypoints input.lon:eq(' + i + ')').val(route[i][2]).change();
			}
			
			if (route[i][3]) // If there is an altitude restriction
				$('#waypoints input.alt:eq(' + i + ')').val(route[i][3]).change();
		}
		
		// JSON.stringify turns undefined into null; this loop turns it back
		fmc.waypoints.route.forEach(function (wpt) {
			if (!wpt[3] || wpt[3] == null) wpt[3] = undefined;
		});
	} else alert ("You did not save the waypoints or you cleared the browser's cache");
};

// Adds a confirm window to prevent accidental reset
ges.resetFlight = function() {
	if (window.confirm('Reset Flight?')) {
		if (ges.lastFlightCoordinates) {
			ges.flyTo(ges.lastFlightCoordinates, true);
			updateLog('Flight reset');
		}
	}
};

// Tracks pause event
ges.togglePause = function() {
	if (!ges.pause) {
		updateLog('Flight paused');
		ges.doPause();
	} else {
		ges.undoPause();
		updateLog('Flight resumed');
	}
};

// FMC button
$('<button>')
	.addClass('btn btn-success gefs-stopPropagation')
	.attr('type', 'button')
	.attr('data-toggle', 'modal')
	.attr('data-target', '#fmcModal')
	.css('margin-left','1px')
	.text('FMC ')
	.append( $('<i>').addClass('icon-list-alt'))
	.appendTo('div.setup-section:nth-child(2)');

// FMC modal UI
$('<div>')
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
													.addClass('btn btn-inverse')
													.attr('type', 'button')
													.text('Save Route ')
													.append( $('<i>').addClass('icon-file icon-white'))
													.click(function() {
														fmc.waypoints.saveData();
													})
													.css('margin-right', '3px')
											,	$('<button>')
													.addClass('btn btn-inverse')
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
											.text('Arrival Airport Altitude')
									,	$('<input>')
											.attr('type','number')
											.attr('placeholder','ft.')
											.css('width','55px')
											.change(function() {
												arrivalAlt = Number($(this).val());
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
							
						// AUTO-CLIMB/DESCENT, CRUISE ALT ROW
						$('<table>')
							.append(
							$('<tr>')
								.append(
								$('<td>')
									.append(
									$('<button>')
										.addClass('btn')
										.attr('id','vnavButton')
										.text('VNAV ')
										.append( $('<i>').addClass('icon icon-resize-vertical'))
										.click(function() {
											toggleVNAV();
										})
									)
							,	$('<td>')
									.append(
									$('<div>')
										.css('margin-top', '5px')
										.addClass('input-prepend input-append')
										.append( 
										$('<span>')
											.addClass('add-on')
											.text('Cruise Alt.')
									,	$('<input>')
											.attr('type', 'number')
											.attr('step', '100')
											.attr('min', '0')
											.attr('max', '100000')
											.attr('placeholder', 'ft')
											.css('width', '80px')
											.change(function() {
												cruise = $(this).val();
											})
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
						$('<th>Enter a SkyVector link or waypoints seperated by spaces</th>'),
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
										.text('SkyVector / Waypoints ')
										.append( $('<i>').addClass('icon-globe'))
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
	).appendTo('body');

// External distance indicator
$('<div>')
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
	).appendTo('td.gefs-f-standard');
	
// Hides backdrop for the modal	
$('#fmcModal').modal({
	backdrop: false,
	show: false
});

// Initialize to 1 waypoint input field
fmc.waypoints.addWaypoint();

// Enables VNAV function
function toggleVNAV() {
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

// Shifts the waypoint n facing direction d 1 step; element r shifts to right place
function shiftWaypoint(r, n, d) {
	var waypoints = fmc.waypoints;
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

// Clears the log
function removeLogData() {
	$('#logData tr').remove('.data');
}

// Prototype, moves array elements
Array.prototype.move = function(index1, index2) {
	if (index2 >= this.length) {
		var k = index2 - this.length;
		while ((k--) + 1) {
			this.push(undefined);
		}
	}
	this.splice(index2, 0, this.splice(index1, 1)[0]);
	return this;
};

// "T" Keyup bug fix
$('#fmcModal').keyup(function(event) {
	event.stopImmediatePropagation();
});
