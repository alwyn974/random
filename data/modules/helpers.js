const luxon = require("luxon");

function getDateTime(isoString) {
  return luxon.DateTime.fromISO(isoString).setLocale('fr');
}

function formatDate(isoString, format="dd/MM/yyyy hh:mm") {
//   return getDateTime(isoString).toFormat(format);
  return getDateTime(isoString).toLocaleString(luxon.DateTime.DATETIME_MED_WITH_SECONDS);
}

function simpleDate(isoString) {
  return formatDate(isoString);
}

function toC(val)
{
    return val ? "VRAI" : "FAUX";
}