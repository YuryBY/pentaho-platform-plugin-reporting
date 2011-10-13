var ReportViewer = {

  load: function() {
    this.createRequiredHooks();

    var paramDefn = ReportViewer.fetchParameterDefinition();

    this.panel = new pentaho.common.prompting.PromptPanel(
      'promptPanel',
      paramDefn);
    this.panel.submit = ReportViewer.submitReport;
    this.panel.getParameterDefinition = ReportViewer.fetchParameterDefinition.bind(ReportViewer);
    this.panel.schedule = ReportViewer.scheduleReport;

    // Provide our own text formatter
    this.panel.createDataTransportFormatter = ReportViewer.createDataTransportFormatter.bind(ReportViewer);
    this.panel.createFormatter = ReportViewer.createFormatter.bind(ReportViewer);

    // Provide our own i18n function
    var msgs = new ReportViewerMessages();
    this.panel.getString = msgs.getString.bind(msgs);

    this.panel.init();
  },

  createRequiredHooks: function() {
    if (window.reportViewer_openUrlInDialog || top.reportViewer_openUrlInDialog) {
      return;
    }
    if (!top.mantle_initialized) {
      top.mantle_openTab = function(name, title, url) {
        window.open(url, '_blank');
      }
    }
    if (top.mantle_initialized) {
      top.reportViewer_openUrlInDialog = function(title, url, width, height) {
        top.urlCommand(url, title, true, width, height);
      }
    } else {
      top.reportViewer_openUrlInDialog = ReportViewer.openUrlInDialog;
    }
    window.reportViewer_openUrlInDialog = top.reportViewer_openUrlInDialog;
    window.reportViewer_hide = ReportViewer.hide;
  },

  getLocale: function() {
    var locale = this.getUrlParameters().locale;
    if (locale && locale.length > 2) {
      locale = locale.substring(0, 2);
    }
    return locale;
  },

  openUrlInDialog: function() {
    alert("not implemented");
  },

  /**
   * Hide the prompt panel.
   * TODO: With new style changes, should this disable the toolbar? Hiding the panel without disabling the toolbar
   * button wont be a nice user experience.
   */
  hide: function(promptPanel) {
    promptPanel.hide();
  },

  parameterParser: new pentaho.common.prompting.ParameterXmlParser(),
  parseParameterDefinition: function(xmlString) {
    // Provide a custom parameter normalization method unique to report viewer
    this.parameterParser.normalizeParameterValue = ReportViewer.normalizeParameterValue.bind(ReportViewer);
    return this.parameterParser.parseParameterXml(xmlString);
  },

  getUrlParameters: function() {
    var urlParams = {};
    var e,
        a = /\+/g,  // Regex for replacing addition symbol with a space
        reg = /([^&=]+)=?([^&]*)/g,
        decode = function (s) { return decodeURIComponent(s.replace(a, " ")); },
        query = window.location.search.substring(1);

    while (e = reg.exec(query)) {
      var paramName = decode(e[1]);
      var paramVal = decode(e[2]);

      if (urlParams[paramName] !== undefined) {
        paramVal = $.isArray(urlParams[paramName]) 
          ? urlParams[paramName].push(paramVal)
          : [urlParams[paramName], paramVal];
      }
      urlParams[paramName] = paramVal;
    }
    return urlParams;
  },

  /**
   * Loads the parameter xml definition from the server.
   */
  fetchParameterDefinition: function(promptPanel) {
    var options = this.getUrlParameters();
    // If we aren't passed a prompt panel this is the first request
    if (promptPanel) {
      $.extend(options, promptPanel.getParameterValues());
    }
    options['renderMode'] = promptPanel ? 'PARAMETER' : 'XML';

    // Never send the session back. This is generated by the server.
    delete options['::session'];

    var newParamDefn;
    $.ajax({
      async: false,
      cache: false,
      type: 'POST',
      url: webAppPath + '/content/reporting',
      data: options,
      dataType:'text',
      success: function(xmlString) {
        try {
          newParamDefn = ReportViewer.parseParameterDefinition(xmlString);
          // Make sure we retrain the current auto-submit setting
          var currentAutoSubmit = promptPanel ? promptPanel.getAutoSubmitSetting() : undefined;
          if (currentAutoSubmit != undefined) {
            newParamDefn.autoSubmitUI = currentAutoSubmit;
          }
        } catch (e) {
          alert('Error parsing parameter xml: ' + e); // TODO Replace with error dialog
        }
      }.bind(this),
      error: function(xml) {
        alert('Error loading parameter information: ' + xml); // TODO replace with error dialog
      }
    });
    return newParamDefn;
  },

  _updateReport: function(promptPanel, renderMode) {
    if (promptPanel.paramDefn.promptNeeded) {
      $('#' + this.htmlObject).attr('src', 'about:blank');
      return; // Don't do anything if we need to prompt
    }
    var options = promptPanel.getParameterValues();
    options['renderMode'] = renderMode;

    // Never send the session back. This is generated by the server.
    delete options['::session'];

    var url = "/pentaho/content/reporting?";
    var params = [];
    var addParam = function(encodedKey, value) {
      if(value.length > 0) {
        params.push(encodedKey + '=' + encodeURIComponent(value));
      }
    }
    $.each(options, function(key, value) {
      if (value === null || typeof value == 'undefined') {
        return; // continue
      }
      var encodedKey = encodeURIComponent(key);
      if ($.isArray(value)) {
        var val = [];
        $.each(value, function(i, v) {
          addParam(encodedKey, v);
        });
      } else {
        addParam(encodedKey, value);
      }
    });

    // Add file params after so they're not encoded twice
    params.push("solution=" + Dashboards.getQueryParameter("solution"));
    params.push("path=" + Dashboards.getQueryParameter("path"));
    params.push("name=" + Dashboards.getQueryParameter("name"));

    url += params.join("&");
    $('#report').attr("src", url);
  },

  submitReport: function(promptPanel) {
    ReportViewer._updateReport(promptPanel, 'REPORT');
  },

  scheduleReport: function(promptPanel) {
    ReportViewer._updateReport(promptPanel, 'SUBSCRIBE');
  },

  /**
   * Create a text formatter that formats to/from text. This is designed to convert between data formatted as a string
   * and the Reporting Engine's expected format for that object type.
   * e.g. "01/01/2003" <-> "2003-01-01T00:00:00.000-0500"
   */
  createDataTransportFormatter: function(paramDefn, parameter, pattern) {
    var formatterType = this._formatTypeMap[parameter.type];
    if (formatterType == 'number') {
      return {
        format: function(object) {
          return formatter.format(object);
        },
        parse: function(s) {
          return '' + formatter.parse(s);
        }
      }
    } else if (formatterType == 'date') {
      return this._createDateTransportFormatter(parameter);
    }
  },

  /**
   * Create a text formatter that can convert between a parameter's defined format and the transport
   * format the Pentaho Reporting Engine expects.
   */
  createFormatter: function(paramDefn, parameter, pattern) {
    if (!jsTextFormatter) {
      console.log("Unable to find formatter module. No text formatting will be possible.");
      return;
    }
    // Create a formatter if a date format was provided and we're not a list parameter type. They are
    // mutually exclusive.
    var dataFormat = pattern || parameter.attributes['data-format'];
    if (!parameter.list && dataFormat) {
      return jsTextFormatter.createFormatter(parameter.type, dataFormat);
    }
  },

  _formatTypeMap: {
    'number': 'number',
    'java.lang.Number': 'number',
    'java.lang.Byte': 'number',
    'java.lang.Short': 'number',
    'java.lang.Integer': 'number',
    'java.lang.Long': 'number',
    'java.lang.Float': 'number',
    'java.lang.Double': 'number',
    'java.math.BigDecimal': 'number',
    'java.math.BigInteger': 'number',
    
    'date': 'date',
    'java.util.Date': 'date',
    'java.sql.Date': 'date',
    'java.sql.Time': 'date',
    'java.sql.Timestamp': 'date'
  },

  _initDateFormatters: function() {
    // Lazily create all date formatters since we may not have createFormatter available when we're loaded
    if (!this.dateFormatters) {
      this.dateFormatters = {
        'with-timezone': jsTextFormatter.createFormatter('date', "yyyy-MM-dd'T'HH:mm:ss.SSSZ"),
        'without-timezone': jsTextFormatter.createFormatter('date', "yyyy-MM-dd'T'HH:mm:ss.SSS"),
        'utc': jsTextFormatter.createFormatter('date', "yyyy-MM-dd'T'HH:mm:ss.SSS'+0000'"),
        'simple': jsTextFormatter.createFormatter('date', "yyyy-MM-dd")
      }
    }
  },

  /**
   * Create a formatter to pass data to/from the Pentaho Reporting Engine. This is to maintain compatibility
   * with the Parameter XML output from the Report Viewer.
   */
  _createDataTransportFormatter: function(parameter, formatter) {
    var formatterType = this._formatTypeMap[parameter.type];
    if (formatterType == 'number') {
      return {
        format: function(object) {
          return formatter.format(object);
        },
        parse: function(s) {
          return '' + formatter.parse(s);
        }
      }
    } else if (formatterType == 'date') {
      var transportFormatter = this._createDateTransportFormatter(parameter);
      return {
        format: function(dateString) {
          return formatter.format(transportFormatter.parse(dateString));
        },
        parse: function(s) {
          return transportFormatter.format(formatter.parse(s));
        }
      }
    }
  },

  /**
   * This text formatter converts a Date to/from the internal transport format (ISO-8601) used by Pentaho Reporting Engine
   * and found in parameter xml generated for Report Viewer.
   */
  _createDateTransportFormatter: function(parameter, s) {
    var timezone = parameter.attributes['timezone'];
    this._initDateFormatters();
    return {
      format: function(date) {
        if ('client' === timezone) {
          return this.dateFormatters['with-timezone'].format(date);
        }
        // Take the date string as it comes from the server, cut out the timezone information - the
        // server will supply its own here.
        if (parameter.timezoneHint) {
          if (!this.dateFormatters[parameter.timezoneHint]) {
            this.dateFormatters[parameter.timezoneHint] = jsTextFormatter.createFormatter('date', "yyyy-MM-dd'T'HH:mm:ss.SSS" + "'" + parameter.timezoneHint + "'");
          }
          return this.dateFormatters[parameter.timezoneHint].format(date);
        } else {
          if ('server' === timezone || !timezone) {
            return this.dateFormatters['without-timezone'].format(date);
          } else if ('utc' === timezone) {
            return this.dateFormatters['utc'].format(date);
          } else {
            var offset = ReportViewer.timeutil.getOffsetAsString(timezone);
            if (!this.dateFormatters[offset]) {
              this.dateFormatters[offset] = jsTextFormatter.createFormatter('date', "yyyy-MM-dd'T'HH:mm:ss.SSS'" + offset + "'");
            }
            return this.dateFormatters[offset].format(date);
          }
        }
      }.bind(this),
      parse: function(s) {
        if ('client' === timezone) {
          try {
            // Try to parse with timezone info
            return this.dateFormatters['with-timezone'].parse(s);
          } catch (e) {
            // ignore, keep trying
          }
        }
        try {
          return this.parseDateWithoutTimezoneInfo(s);
        } catch (e) {
          // ignore, keep trying
        }
        try {
          if (s.length == 10) {
            return this.dateFormatters['simple'].parse(s);
          }
        } catch (e) {
          // ignore, keep trying
        }
        try {
          return new Date(parseFloat(s));
        } catch (e) {
          // ignore, we're done here
        }
        return ''; // this represents a null in CDF
      }.bind(this)
    };
  },

  parseDateWithoutTimezoneInfo: function(dateString) {
    // Try to parse without timezone info
    if (dateString.length === 28)
    {
      dateString = dateString.substring(0, 23);
    }
    return this.dateFormatters['without-timezone'].parse(dateString);
  },

  /**
   * Updates date values to make sure the timezone information is correct.
   */
  normalizeParameterValue: function(parameter, type, value) {
    if (value == null || type == null) {
      return null;
    }

    // Strip out actual type from Java array types
    var m = type.match('^\\[L([^;]+);$');
    if (m != null && m.length === 2) {
      type = m[1];
    }

    switch(type) {
      case 'java.util.Date':
      case 'java.sql.Date':
      case 'java.sql.Time':
      case 'java.sql.Timestamp':
        var timezone = parameter.attributes['timezone'];
        if (!timezone || timezone == 'server') {
          if (parameter.timezoneHint == undefined) {
            // Extract timezone hint from data if we can and update the parameter
            if (value.length == 28) {
              // Update the parameter's timezone hint
              parameter.timezoneHint = value.substring(23, 28);
            }
          }
          return value;
        }

        if(timezone == 'client') {
          return value;
        }

        // for every other mode (fixed timezone modes), translate the time into the specified timezone
        if ((parameter.timezoneHint != undefined && $.trim(parameter.timezoneHint).length != 0)
         && value.match(parameter.timezoneHint + '$'))
        {
          return value;
        }

        // the resulting time will have the same universal time as the original one, but the string
        // will match the timeoffset specified in the timezone.
        return this.convertTimeStampToTimeZone(value, timezone);
    }
    return value;
  },

  /**
   * Converts a time from a arbitary timezone into the local timezone. The timestamp value remains unchanged,
   * but the string representation changes to reflect the give timezone.
   *
   * @param value the timestamp as string in UTC format
   * @param timezone the target timezone
   * @return the converted timestamp string.
   */
  convertTimeStampToTimeZone: function(value, timezone) {
    this._initDateFormatters();
    // Lookup the offset in minutes
    var offset = ReportViewer.timeutil.getOffset(timezone);

    var localDate = this.parseDateWithoutTimezoneInfo(value);
    var utcDate = this.dateFormatters['with-timezone'].parse(value);
    var offsetText = ReportViewer.timeutil.formatOffset(offset);

    var nativeOffset = -(new Date().getTimezoneOffset());

    var time = localDate.getTime() + (offset * 60000) + (utcDate.getTime() - localDate.getTime() - (nativeOffset * 60000));
    var localDateWithShift = new Date(time);

    return this.dateFormatters['without-timezone'].format(localDateWithShift) + offsetText;
  }
};